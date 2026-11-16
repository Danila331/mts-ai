package postgres

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/jackc/pgerrcode"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/Danila331/mts-ai/backend/internal/chat"
	"github.com/Danila331/mts-ai/backend/internal/dialog"
	"github.com/Danila331/mts-ai/backend/internal/feedback"
	"github.com/Danila331/mts-ai/backend/internal/lead"
	"github.com/Danila331/mts-ai/backend/internal/passport"
	"github.com/Danila331/mts-ai/backend/internal/session"
	"github.com/Danila331/mts-ai/backend/internal/storage/postgres/db"
)

// SaveAnswer кладёт ответ в журнал. Ответ чата с сессией ложится и в
// переписку сессии — в той же транзакции, чтобы журнал и переписка не
// разошлись.
func (s *Store) SaveAnswer(ctx context.Context, rec chat.Record) error {
	return s.inTx(ctx, func(q *db.Queries) error {
		if err := q.SaveAnswer(ctx, db.SaveAnswerParams{
			ID:        rec.ID,
			Mode:      rec.Mode,
			Question:  rec.Question,
			Answer:    rec.Text,
			Fallback:  rec.Fallback,
			Error:     rec.Error,
			Model:     rec.Model,
			Turns:     int32(rec.Turns),
			Timings:   object(rec.Timings),
			Guard:     object(rec.Guard),
			RequestID: rec.RequestID,
			SessionID: optional(rec.SessionID),
			Sources:   jsonArray(rec.Sources()),
		}); err != nil {
			return err
		}
		if rec.SessionID == "" {
			return nil
		}
		if err := q.LockSessionMessages(ctx, rec.SessionID); err != nil {
			return err
		}
		// Повтор доставки (тот же id ответа) вторую реплику не добавляет.
		if last, err := q.LastSessionMessage(ctx, rec.SessionID); err == nil &&
			last.Role == string(dialog.RoleAssistant) && last.Content == rec.Text {
			return nil
		}
		return q.AddSessionMessage(ctx, db.AddSessionMessageParams{
			SessionID: rec.SessionID, Role: string(dialog.RoleAssistant), Content: rec.Text, AnswerID: optional(rec.ID),
		})
	})
}

// SyncTurns дописывает в переписку сессии реплики запроса, которых в ней
// ещё нет (dialog.Unseen). Сессия должна уже существовать (TouchSession).
func (s *Store) SyncTurns(ctx context.Context, sessionID string, turns []dialog.Turn) error {
	return s.inTx(ctx, func(q *db.Queries) error {
		if err := q.LockSessionMessages(ctx, sessionID); err != nil {
			return err
		}
		var last *dialog.Turn
		row, err := q.LastSessionMessage(ctx, sessionID)
		switch {
		case err == nil:
			last = &dialog.Turn{Role: dialog.Role(row.Role), Content: row.Content}
		case !errors.Is(err, pgx.ErrNoRows):
			return err
		}
		for _, t := range dialog.Unseen(last, turns) {
			if err := q.AddSessionMessage(ctx, db.AddSessionMessageParams{
				SessionID: sessionID, Role: string(t.Role), Content: t.Content,
			}); err != nil {
				return err
			}
		}
		return nil
	})
}

// TouchSession создаёт сессию на первом вопросе и обновляет её время на
// каждом следующем; заголовок остаётся от первого. Страница виджета
// пишется при создании и заменяется, только если пришла непустая. Роль
// заменяется, только если у вопроса она известна или клиент её снял.
func (s *Store) TouchSession(ctx context.Context, ref session.Ref, mode, title string, role session.RoleHint,
	level session.LevelChoice) error {
	page := []byte(ref.Page)
	if len(page) == 0 {
		page = []byte("{}")
	}
	return s.Queries.UpsertSession(ctx, db.UpsertSessionParams{
		ID: ref.ID, Channel: string(ref.Channel), Mode: mode, Title: title, Page: page,
		Role: string(role.Role), RoleSource: string(role.Source),
		Level: string(level.Level), LevelSet: level.Chosen,
	})
}

// History — сессия, её переписка по порядку и заявка, если она есть. У
// сессий старше 000009 переписки нет — реплики собираются из журнала
// ответов: вопрос клиента, затем ответ.
func (s *Store) History(ctx context.Context, id string) (session.History, error) {
	row, err := s.Queries.GetSession(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return session.History{}, session.ErrNotFound
	}
	if err != nil {
		return session.History{}, err
	}
	view := passport.Parse(row.Passport).Render()
	h := session.History{
		Session: session.Session{
			ID: row.ID, Channel: row.Channel, Mode: row.Mode, Title: row.Title,
			Page: json.RawMessage(row.Page), Passport: &view, Role: row.Role, RoleSource: row.RoleSource, Level: row.Level,
			CreatedAt: row.CreatedAt, UpdatedAt: row.UpdatedAt,
		},
		Turns: []session.Turn{},
	}
	msgs, err := s.Queries.SessionMessages(ctx, id)
	if err != nil {
		return session.History{}, err
	}
	for _, m := range msgs {
		t := session.Turn{Role: m.Role, Content: m.Content, Fallback: m.Fallback, At: m.CreatedAt}
		if m.AnswerID != nil {
			t.AnswerID = *m.AnswerID
			_ = json.Unmarshal(m.Sources, &t.Sources)
		}
		h.Turns = append(h.Turns, t)
	}
	if len(msgs) == 0 {
		answers, err := s.Queries.SessionAnswers(ctx, &id)
		if err != nil {
			return session.History{}, err
		}
		for _, a := range answers {
			var sources []string
			_ = json.Unmarshal(a.Sources, &sources)
			h.Turns = append(h.Turns,
				session.Turn{Role: "user", Content: a.Question, At: a.CreatedAt},
				session.Turn{Role: "assistant", Content: a.Answer, AnswerID: a.ID, Sources: sources,
					Fallback: a.Fallback, At: a.CreatedAt},
			)
		}
	}
	l, err := s.Queries.SessionLead(ctx, &id)
	switch {
	case err == nil:
		h.LeadCode, h.LeadKind = l.Code, l.Kind
	case !errors.Is(err, pgx.ErrNoRows):
		return session.History{}, err
	}
	return h, nil
}

// SessionList — диалоги менеджера, новые сверху: чат клиентов, с заявкой и
// без.
func (s *Store) SessionList(ctx context.Context, limit, offset int) (session.ListPage, error) {
	rows, err := s.Queries.ListSessions(ctx, db.ListSessionsParams{RowLimit: int32(limit), RowOffset: int32(offset)})
	if err != nil {
		return session.ListPage{}, err
	}
	total, err := s.Queries.CountSessions(ctx)
	if err != nil {
		return session.ListPage{}, err
	}
	page := session.ListPage{Items: make([]session.ListItem, 0, len(rows)), Total: int(total)}
	for _, r := range rows {
		view := passport.Parse(r.Passport).Render()
		page.Items = append(page.Items, session.ListItem{
			ID: r.ID, Channel: r.Channel, Title: r.Title, Role: r.Role,
			Product: view.Product, ProductLabel: view.ProductLabel,
			Messages: int(r.MessageCount), HasLead: r.LeadCode != "", LeadCode: r.LeadCode, LeadKind: r.LeadKind,
			CreatedAt: r.CreatedAt, UpdatedAt: r.UpdatedAt,
		})
	}
	return page, nil
}

// CreateLead сохраняет заявку. Занятый номер отдаётся как
// lead.ErrCodeTaken — сервис попробует другой.
func (s *Store) CreateLead(ctx context.Context, l *lead.Lead) error {
	messages, err := json.Marshal(l.Messages)
	if err != nil {
		return err
	}
	if l.Messages == nil {
		messages = []byte("[]")
	}
	// Заявка без оценки (старые вызовы) — пустой объект, а не оценка с
	// пустыми полями.
	scored := []byte("{}")
	if l.Score.Grade != "" {
		if scored, err = json.Marshal(l.Score); err != nil {
			return err
		}
	}
	callback := []byte("{}")
	if !l.Callback.Empty() {
		if callback, err = json.Marshal(l.Callback); err != nil {
			return err
		}
	}
	row, err := s.Queries.CreateLead(ctx, db.CreateLeadParams{
		Code:          l.Code,
		Name:          l.Name,
		Phone:         l.Phone,
		Company:       l.Company,
		Comment:       l.Comment,
		Summary:       l.Summary,
		SummarySource: summarySource(l.SummarySource),
		Messages:      messages,
		RequestID:     l.RequestID,
		SessionID:     optional(l.SessionID),
		Passport:      object(l.Passport),
		Score:         scored,
		// Предпочтение по времени звонка (T4), не запись на время.
		CallbackPreference: callback,
		Kind:               leadKind(l.Kind),
	})
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && pgErr.Code == pgerrcode.UniqueViolation && pgErr.ConstraintName == "leads_code_uq" {
		return lead.ErrCodeTaken
	}
	if err != nil {
		return err
	}
	l.ID, l.CreatedAt = row.ID, row.CreatedAt
	return nil
}

// errLeadNotFound — обновлять нечего: заявки с таким id нет.
var errLeadNotFound = errors.New("заявка не найдена")

// UpdateLeadSummary заменяет резюме сохранённой заявки.
func (s *Store) UpdateLeadSummary(ctx context.Context, l *lead.Lead) error {
	n, err := s.Queries.UpdateLeadSummary(ctx, db.UpdateLeadSummaryParams{
		ID:            l.ID,
		Summary:       l.Summary,
		SummarySource: summarySource(l.SummarySource),
	})
	if err != nil {
		return err
	}
	if n == 0 {
		return errLeadNotFound
	}
	return nil
}

// leadKind — пустой тип — обратный звонок, как у заявок до типов.
func leadKind(k lead.Kind) string {
	if k == "" {
		return string(lead.KindCallback)
	}
	return string(k)
}

// summarySource — пустой источник — это список вопросов: так заявка
// записывается до резюме моделью.
func summarySource(s lead.SummarySource) string {
	if s == "" {
		return string(lead.SummaryDigest)
	}
	return string(s)
}

// CreateFeedback сохраняет оценку.
func (s *Store) CreateFeedback(ctx context.Context, f feedback.Feedback) error {
	return s.Queries.CreateFeedback(ctx, db.CreateFeedbackParams{
		SessionID: f.SessionID,
		MessageID: f.MessageID,
		Rating:    int16(f.Rating),
		Comment:   f.Comment,
		Question:  f.Question,
		Answer:    f.Answer,
	})
}

// object — JSON-объект для колонки jsonb NOT NULL. Ядро может прислать
// null или ничего — это пустой объект, а не нарушение NOT NULL.
func object(raw json.RawMessage) []byte {
	var probe map[string]any
	if len(raw) == 0 || json.Unmarshal(raw, &probe) != nil || probe == nil {
		return []byte("{}")
	}
	return raw
}

// optional — пустая строка как NULL: ответ без сессии.
func optional(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

// jsonArray — список строк для колонки jsonb NOT NULL; nil — пустой массив.
func jsonArray(items []string) []byte {
	if items == nil {
		items = []string{}
	}
	raw, _ := json.Marshal(items)
	return raw
}

// LoadPassport — паспорт сессии; сессии нет — session.ErrNotFound.
func (s *Store) LoadPassport(ctx context.Context, id string) (passport.Passport, error) {
	raw, err := s.Queries.GetPassport(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return passport.Passport{}, session.ErrNotFound
	}
	if err != nil {
		return passport.Passport{}, err
	}
	return passport.Parse(raw), nil
}

// SavePassport записывает паспорт сессии целиком.
func (s *Store) SavePassport(ctx context.Context, id string, p passport.Passport) error {
	raw, err := json.Marshal(p)
	if err != nil {
		return err
	}
	n, err := s.Queries.SavePassport(ctx, db.SavePassportParams{ID: id, Passport: raw})
	if err != nil {
		return err
	}
	if n == 0 {
		return session.ErrNotFound
	}
	return nil
}

// Stats — наблюдаемые исходы для GET /api/stats. session_id у ответов и
// заявок — из миграции 000003_sessions (NULL у ответов без сессии).
func (s *Store) Stats(ctx context.Context) (chat.ConversationStats, error) {
	var out chat.ConversationStats
	err := s.Pool.QueryRow(ctx, `
		SELECT
			(SELECT count(*) FROM answers),
			(SELECT count(*) FROM answers WHERE NOT fallback AND error = ''),
			(SELECT count(*) FROM answers WHERE error = ''),
			(SELECT count(DISTINCT session_id) FROM answers WHERE coalesce(session_id, '') <> ''),
			(SELECT count(*) FROM leads),
			(SELECT count(DISTINCT session_id) FROM leads WHERE coalesce(session_id, '') <> '')
	`).Scan(&out.Answers, &out.Answered, &out.NoBoundary, &out.Sessions, &out.Leads, &out.LeadSessions)
	if err != nil {
		return out, err
	}
	out.Rates()
	return out, nil
}
