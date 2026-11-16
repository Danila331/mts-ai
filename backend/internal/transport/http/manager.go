package http

import (
	"errors"
	"net/http"
	"strconv"
	"strings"

	"github.com/labstack/echo/v4"

	"github.com/Danila331/mts-ai/backend/internal/analytics"
	"github.com/Danila331/mts-ai/backend/internal/lead"
	"github.com/Danila331/mts-ai/backend/internal/session"
)

const (
	// leadsDefaultLimit и leadsMaxLimit — размер страницы списка заявок.
	leadsDefaultLimit = 50
	leadsMaxLimit     = 200
)

// leadList — заявки менеджера, новые сверху: ?limit=&offset=&status=.
func (s *Server) leadList(c echo.Context) error {
	if s.deps.Board == nil {
		return fail(c, http.StatusNotFound, "not found")
	}
	limit, err := intParam(c, "limit", leadsDefaultLimit, 1, leadsMaxLimit)
	if err != nil {
		return fail(c, http.StatusBadRequest, err.Error())
	}
	offset, err := intParam(c, "offset", 0, 0, 1<<30)
	if err != nil {
		return fail(c, http.StatusBadRequest, err.Error())
	}
	var status lead.Status
	if raw := strings.TrimSpace(c.QueryParam("status")); raw != "" {
		if status, err = lead.ParseStatus(raw); err != nil {
			return s.mapErr(c, err)
		}
	}
	page, err := s.deps.Board.LeadList(c.Request().Context(), status, limit, offset)
	if err != nil {
		return s.mapErr(c, err)
	}
	return c.JSON(http.StatusOK, struct {
		lead.ListPage
		Statuses []lead.StatusInfo `json:"statuses"`
	}{page, lead.Statuses})
}

// leadCardResponse — заявка и история её разговора. History пуст, если
// заявка из старой формы или сессию удалили по сроку хранения: диалог на
// момент отправки в таком случае остаётся в messages.
type leadCardResponse struct {
	lead.Card
	History *session.History `json:"history"`
}

// leadCard — заявка целиком и разговор клиента.
func (s *Server) leadCard(c echo.Context) error {
	if s.deps.Board == nil {
		return fail(c, http.StatusNotFound, "not found")
	}
	ctx := c.Request().Context()
	card, err := s.deps.Board.LeadCard(ctx, c.Param("code"))
	if errors.Is(err, lead.ErrNotFound) {
		return fail(c, http.StatusNotFound, "Заявки нет: не было или удалена по сроку хранения")
	}
	if err != nil {
		return s.mapErr(c, err)
	}
	out := leadCardResponse{Card: card}
	if card.SessionID != "" && s.deps.Sessions != nil {
		h, err := s.deps.Sessions.History(ctx, card.SessionID)
		switch {
		case err == nil:
			out.History = &h
		case !errors.Is(err, session.ErrNotFound):
			return s.mapErr(c, err)
		}
	}
	return c.JSON(http.StatusOK, out)
}

type leadStatusRequest struct {
	Status string `json:"status"`
}

// leadStatus меняет статус заявки; неизвестный статус — 400.
func (s *Server) leadStatus(c echo.Context) error {
	if s.deps.Board == nil {
		return fail(c, http.StatusNotFound, "not found")
	}
	var body leadStatusRequest
	if err := decode(c, &body); err != nil {
		return s.mapErr(c, err)
	}
	status, err := lead.ParseStatus(strings.TrimSpace(body.Status))
	if err != nil {
		return s.mapErr(c, err)
	}
	err = s.deps.Board.SetLeadStatus(c.Request().Context(), c.Param("code"), status)
	if errors.Is(err, lead.ErrNotFound) {
		return fail(c, http.StatusNotFound, "Заявки нет: не было или удалена по сроку хранения")
	}
	if err != nil {
		return s.mapErr(c, err)
	}
	return c.JSON(http.StatusOK, map[string]string{"status": string(status), "status_label": status.Label()})
}

// intParam — целое из строки запроса в [min, max]; пусто — умолчание.
func intParam(c echo.Context, name string, def, min, max int) (int, error) {
	raw := strings.TrimSpace(c.QueryParam(name))
	if raw == "" {
		return def, nil
	}
	n, err := strconv.Atoi(raw)
	if err != nil || n < min || n > max {
		return 0, errors.New(name + ": целое от " + strconv.Itoa(min) + " до " + strconv.Itoa(max))
	}
	return n, nil
}

// analytics — воронка, срезы и пробелы базы за 7 или 30 дней (T6).
func (s *Server) analytics(c echo.Context) error {
	if s.deps.Analytics == nil {
		return fail(c, http.StatusNotFound, "not found")
	}
	var days int
	raw := strings.TrimSpace(c.QueryParam("days"))
	if raw != "" {
		n, err := strconv.Atoi(raw)
		if err != nil {
			return fail(c, http.StatusBadRequest, "days: 7 или 30")
		}
		days = n
	}
	days, err := analytics.ParseDays(days, raw != "")
	if err != nil {
		return s.mapErr(c, err)
	}
	report, err := s.deps.Analytics.Analytics(c.Request().Context(), days)
	if err != nil {
		return s.mapErr(c, err)
	}
	return c.JSON(http.StatusOK, report)
}
