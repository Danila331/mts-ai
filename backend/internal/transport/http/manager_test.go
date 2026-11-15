package http

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/Danila331/mts-ai/backend/internal/chat"
	"github.com/Danila331/mts-ai/backend/internal/config"
	"github.com/Danila331/mts-ai/backend/internal/lead"
	"github.com/Danila331/mts-ai/backend/internal/lead/score"
	"github.com/Danila331/mts-ai/backend/internal/passport"
	"github.com/Danila331/mts-ai/backend/internal/session"
)

// Заявки в памяти: то же, что отдаёт хранилище, но без базы.
func (m *memStore) LeadList(_ context.Context, status lead.Status, limit, offset int) (lead.ListPage, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	var all []lead.ListItem
	// Новые сверху.
	for i := len(m.leads) - 1; i >= 0; i-- {
		l := m.leads[i]
		item := leadItem(l)
		if status == "" || item.Status == status {
			all = append(all, item)
		}
	}
	total := len(all)
	if offset > len(all) {
		offset = len(all)
	}
	all = all[offset:]
	if limit < len(all) {
		all = all[:limit]
	}
	return lead.ListPage{Items: append([]lead.ListItem{}, all...), Total: total}, nil
}

func leadItem(l lead.Lead) lead.ListItem {
	status := l.Status
	if status == "" {
		status = lead.StatusNew
	}
	return lead.NewListItem(l.Code, l.CreatedAt, l.Name, l.Company, l.Kind, l.Score.Grade, status, l.Score.Product)
}

func (m *memStore) LeadCard(_ context.Context, code string) (lead.Card, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, l := range m.leads {
		if l.Code == code {
			return lead.Card{ListItem: leadItem(l), Phone: l.Phone, Summary: l.Summary, SessionID: l.SessionID,
				Passport: l.Passport, Score: l.Score, Messages: json.RawMessage(`[]`)}, nil
		}
	}
	return lead.Card{}, lead.ErrNotFound
}

func (m *memStore) SetLeadStatus(_ context.Context, code string, status lead.Status) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	for i := range m.leads {
		if m.leads[i].Code == code {
			m.leads[i].Status = status
			return nil
		}
	}
	return lead.ErrNotFound
}

func seedLeads(store *memStore) {
	now := time.Now()
	store.sessions = map[string]session.Session{
		"sess-hot-0001": {ID: "sess-hot-0001", Channel: "embed", Title: "Нужен учёт", Page: json.RawMessage(`{}`)},
	}
	store.answers = append(store.answers, chatRecord("a1", "sess-hot-0001", "Что такое АСКУЭ?", "Платформа учёта."))
	store.leads = []lead.Lead{
		{Code: "aaaaaaaaaa", Contacts: lead.Contacts{Name: "Тестов Тест Тестович", Phone: "+79000000000", Company: "ООО Учебный склад", Kind: lead.KindDemo},
			Summary: "Задача клиента: учёт", CreatedAt: now.Add(-time.Hour), SessionID: "sess-hot-0001",
			Score: score.Score{Grade: score.Hot, Product: passport.Platform, Reasons: []string{"Подходит"}, Missing: []string{"Схема сбора данных"}}},
		{Code: "bbbbbbbbbb", Contacts: lead.Contacts{Name: "Тестов Тест Тестович"}, Summary: "s", CreatedAt: now},
	}
}

func TestLeadsNeedManager(t *testing.T) {
	s, store := newServer(t, fakeCore(t, goodStream).URL, func(c *config.Config) { c.HTTP.ManagerToken = "manager-token" })
	seedLeads(store)
	for _, path := range []string{"/api/leads", "/api/leads/aaaaaaaaaa"} {
		assert.Equal(t, http.StatusUnauthorized, do(s, http.MethodGet, path, "").Code, path)
		assert.Equal(t, http.StatusUnauthorized, do(s, http.MethodGet, path, "", ManagerHeader, "wrong").Code, path)
	}
	assert.Equal(t, http.StatusUnauthorized,
		do(s, http.MethodPatch, "/api/leads/aaaaaaaaaa/status", `{"status":"done"}`).Code)
	assert.Equal(t, lead.Status(""), store.leads[0].Status, "без токена статус не меняется")

	closed, _ := newServer(t, fakeCore(t, goodStream).URL, nil)
	assert.Equal(t, http.StatusUnauthorized, do(closed, http.MethodGet, "/api/leads", "", ManagerHeader, "").Code,
		"EB_MANAGER_TOKEN не задан — заявки закрыты для всех")
}

func TestLeadListNewestFirst(t *testing.T) {
	s, store := newServer(t, fakeCore(t, goodStream).URL, func(c *config.Config) { c.HTTP.ManagerToken = "manager-token" })
	seedLeads(store)
	manager := []string{ManagerHeader, "manager-token"}

	rec := do(s, http.MethodGet, "/api/leads", "", manager...)
	require.Equal(t, http.StatusOK, rec.Code)
	var page struct {
		Items    []lead.ListItem   `json:"items"`
		Total    int               `json:"total"`
		Statuses []lead.StatusInfo `json:"statuses"`
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &page))
	require.Len(t, page.Items, 2)
	assert.Equal(t, 2, page.Total)
	assert.Len(t, page.Statuses, 4)
	assert.Equal(t, "bbbbbbbbbb", page.Items[0].Code, "новые сверху")
	assert.Equal(t, lead.StatusNew, page.Items[0].Status)
	assert.Equal(t, "Горячая", page.Items[1].GradeLabel)
	assert.Equal(t, "Демо-кабинет платформы учёта", page.Items[1].KindLabel)
	assert.Equal(t, "Платформа учёта", page.Items[1].ProductLabel)

	// Страница и фильтр.
	rec = do(s, http.MethodGet, "/api/leads?limit=1&offset=1", "", manager...)
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &page))
	require.Len(t, page.Items, 1)
	assert.Equal(t, "aaaaaaaaaa", page.Items[0].Code)
	assert.Equal(t, 2, page.Total)

	assert.Equal(t, http.StatusBadRequest, do(s, http.MethodGet, "/api/leads?limit=0", "", manager...).Code)
	assert.Equal(t, http.StatusBadRequest, do(s, http.MethodGet, "/api/leads?limit=999", "", manager...).Code)
	assert.Equal(t, http.StatusBadRequest, do(s, http.MethodGet, "/api/leads?status=nope", "", manager...).Code)
}

func TestLeadCardWithHistory(t *testing.T) {
	s, store := newServer(t, fakeCore(t, goodStream).URL, func(c *config.Config) { c.HTTP.ManagerToken = "manager-token" })
	seedLeads(store)
	manager := []string{ManagerHeader, "manager-token"}

	rec := do(s, http.MethodGet, "/api/leads/aaaaaaaaaa", "", manager...)
	require.Equal(t, http.StatusOK, rec.Code)
	var card struct {
		lead.Card
		History *session.History `json:"history"`
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &card))
	assert.Equal(t, "Задача клиента: учёт", card.Summary)
	assert.Equal(t, []string{"Схема сбора данных"}, card.Score.Missing)
	require.NotNil(t, card.History)
	assert.Len(t, card.History.Turns, 2, "вопрос и ответ сессии")

	// Заявка без сессии — карточка без истории.
	rec = do(s, http.MethodGet, "/api/leads/bbbbbbbbbb", "", manager...)
	require.Equal(t, http.StatusOK, rec.Code)
	assert.Contains(t, rec.Body.String(), `"history":null`)

	assert.Equal(t, http.StatusNotFound, do(s, http.MethodGet, "/api/leads/nope", "", manager...).Code)
}

func TestLeadStatusChange(t *testing.T) {
	s, store := newServer(t, fakeCore(t, goodStream).URL, func(c *config.Config) { c.HTTP.ManagerToken = "manager-token" })
	seedLeads(store)
	manager := []string{ManagerHeader, "manager-token"}

	rec := do(s, http.MethodPatch, "/api/leads/aaaaaaaaaa/status", `{"status":"in_progress"}`, manager...)
	require.Equal(t, http.StatusOK, rec.Code)
	assert.Contains(t, rec.Body.String(), "В работе")
	assert.Equal(t, lead.StatusInProgress, store.leads[0].Status)

	for _, body := range []string{`{"status":"wow"}`, `{"status":""}`, `{}`} {
		assert.Equal(t, http.StatusBadRequest, do(s, http.MethodPatch, "/api/leads/aaaaaaaaaa/status", body, manager...).Code, body)
	}
	assert.Equal(t, lead.StatusInProgress, store.leads[0].Status, "неверный статус ничего не меняет")
	assert.Equal(t, http.StatusNotFound, do(s, http.MethodPatch, "/api/leads/nope/status", `{"status":"done"}`, manager...).Code)

	// Фильтр по статусу видит изменение.
	rec = do(s, http.MethodGet, "/api/leads?status=in_progress", "", manager...)
	assert.Contains(t, rec.Body.String(), `"total":1`)
}

func chatRecord(id, sessionID, question, answer string) chat.Record {
	return chat.Record{Answer: chat.Answer{ID: id, Text: answer, Mode: "chat"}, Question: question, SessionID: sessionID}
}
