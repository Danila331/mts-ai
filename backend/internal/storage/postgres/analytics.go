package postgres

import (
	"context"
	"time"

	"github.com/Danila331/mts-ai/backend/internal/analytics"
	"github.com/Danila331/mts-ai/backend/internal/storage/postgres/db"
)

// Analytics — отчёт за последние days дней: два агрегатных запроса.
func (s *Store) Analytics(ctx context.Context, days int) (analytics.Report, error) {
	since := time.Now().Add(-time.Duration(days) * 24 * time.Hour)
	row, err := s.Queries.AnalyticsSummary(ctx, db.AnalyticsSummaryParams{
		Since: since, MinFields: analytics.MinPassportFields, ContactKeys: analytics.ContactKeys,
	})
	if err != nil {
		return analytics.Report{}, err
	}
	gapRows, err := s.Queries.AnalyticsGaps(ctx, db.AnalyticsGapsParams{Since: since, RowLimit: analytics.GapsLimit})
	if err != nil {
		return analytics.Report{}, err
	}
	gaps := make([]analytics.Gap, 0, len(gapRows))
	for _, g := range gapRows {
		gaps = append(gaps, analytics.Gap{Question: g.Question, Count: int(g.N), LastAt: g.LastAt})
	}
	raw := analytics.Raw{
		Sessions: int(row.Sessions), Answered: int(row.Answered), Filled: int(row.Filled), WithLead: int(row.WithLead),
		Leads: int(row.Leads), Answers: int(row.Answers), Fallbacks: int(row.Fallbacks),
		ByGrade: analytics.DecodeCounts(row.ByGrade), ByKind: analytics.DecodeCounts(row.ByKind),
		SessionsByChannel: analytics.DecodeCounts(row.SessionsByChannel), LeadsByChannel: analytics.DecodeCounts(row.LeadsByChannel),
	}
	return analytics.Build(days, raw, gaps), nil
}
