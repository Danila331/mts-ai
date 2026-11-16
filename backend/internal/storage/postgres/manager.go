package postgres

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/jackc/pgx/v5"

	"github.com/Danila331/mts-ai/backend/internal/lead"
	"github.com/Danila331/mts-ai/backend/internal/lead/score"
	"github.com/Danila331/mts-ai/backend/internal/passport"
	"github.com/Danila331/mts-ai/backend/internal/storage/postgres/db"
)

// LeadList — заявки менеджера, новые сверху. Статус пустой — все.
func (s *Store) LeadList(ctx context.Context, status lead.Status, limit, offset int) (lead.ListPage, error) {
	rows, err := s.Queries.ListLeads(ctx, db.ListLeadsParams{
		Status: string(status), RowLimit: int32(limit), RowOffset: int32(offset),
	})
	if err != nil {
		return lead.ListPage{}, err
	}
	total, err := s.Queries.CountLeads(ctx, string(status))
	if err != nil {
		return lead.ListPage{}, err
	}
	page := lead.ListPage{Items: make([]lead.ListItem, 0, len(rows)), Total: int(total)}
	for _, r := range rows {
		page.Items = append(page.Items, lead.NewListItem(r.Code, r.CreatedAt, r.Name, r.Company,
			lead.Kind(r.Kind), score.Grade(r.Grade), lead.Status(r.Status), passport.Group(r.Product)))
	}
	return page, nil
}

// LeadCard — заявка целиком; нет такой — lead.ErrNotFound.
func (s *Store) LeadCard(ctx context.Context, code string) (lead.Card, error) {
	r, err := s.Queries.GetLeadByCode(ctx, code)
	if errors.Is(err, pgx.ErrNoRows) {
		return lead.Card{}, lead.ErrNotFound
	}
	if err != nil {
		return lead.Card{}, err
	}
	var sc score.Score
	_ = json.Unmarshal(r.Score, &sc)
	if sc.Reasons == nil {
		sc.Reasons = []string{}
	}
	if sc.Missing == nil {
		sc.Missing = []string{}
	}
	var cb lead.Callback
	_ = json.Unmarshal(r.CallbackPreference, &cb)

	c := lead.Card{
		ListItem: lead.NewListItem(r.Code, r.CreatedAt, r.Name, r.Company, lead.Kind(r.Kind), sc.Grade,
			lead.Status(r.Status), sc.Product),
		ID: r.ID.String(), Phone: r.Phone, Comment: r.Comment, Summary: r.Summary,
		SummarySource: lead.SummarySource(r.SummarySource),
		Callback:      cb, CallbackLabel: cb.Label(),
		Passport: json.RawMessage(r.Passport), Score: sc, Messages: json.RawMessage(r.Messages),
	}
	if r.SessionID != nil {
		c.SessionID = *r.SessionID
	}
	if r.StatusChangedAt.Valid {
		t := r.StatusChangedAt.Time
		c.StatusChanged = &t
	}
	return c, nil
}

// SetLeadStatus меняет статус заявки; нет такой — lead.ErrNotFound.
func (s *Store) SetLeadStatus(ctx context.Context, code string, status lead.Status) error {
	_, err := s.Queries.SetLeadStatus(ctx, db.SetLeadStatusParams{Code: code, Status: string(status)})
	if errors.Is(err, pgx.ErrNoRows) {
		return lead.ErrNotFound
	}
	return err
}
