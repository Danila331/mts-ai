// Package metrics — метрики службы для Prometheus.
//
// Свой реестр, а не глобальный: в нём ровно то, что объявлено здесь, и
// тесты, собирающие сервер много раз, не спотыкаются о повторную
// регистрацию. Все методы безопасны на nil: сервер без метрик (тесты,
// EB_METRICS_PORT=0) зовёт те же методы и ничего не считает.
package metrics

import (
	"net/http"
	"strconv"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/collectors"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

type Metrics struct {
	registry *prometheus.Registry

	httpRequests    *prometheus.CounterVec
	httpDuration    *prometheus.HistogramVec
	streams         prometheus.Gauge
	chatOutcomes    *prometheus.CounterVec
	leads           *prometheus.CounterVec
	rateLimited     *prometheus.CounterVec
	rateStoreErrors *prometheus.CounterVec
	retentionPurged *prometheus.CounterVec
}

func New() *Metrics {
	reg := prometheus.NewRegistry()
	reg.MustRegister(collectors.NewGoCollector(), collectors.NewProcessCollector(collectors.ProcessCollectorOpts{}))

	m := &Metrics{
		registry: reg,
		httpRequests: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "eb_http_requests_total",
			Help: "Запросы к API по маршруту, методу и коду ответа.",
		}, []string{"route", "method", "status"}),
		// Корзины до пяти минут: ответ потоком длится до нескольких
		// минут, и стандартные корзины до 10 с сложили бы все ответы
		// в последнюю.
		httpDuration: prometheus.NewHistogramVec(prometheus.HistogramOpts{
			Name:    "eb_http_request_duration_seconds",
			Help:    "Длительность запросов к API, включая поток ответа.",
			Buckets: []float64{.005, .025, .1, .5, 1, 2.5, 5, 10, 20, 40, 60, 120, 180, 300},
		}, []string{"route", "method"}),
		streams: prometheus.NewGauge(prometheus.GaugeOpts{
			Name: "eb_chat_streams_in_flight",
			Help: "Открытые потоки ответа: столько ответов оборвёт выкладка без ожидания.",
		}),
		chatOutcomes: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "eb_chat_answers_total",
			Help: "Ответы ядра по исходу: answered, fallback, core_error, broken, empty.",
		}, []string{"outcome", "mode"}),
		leads: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "eb_leads_total",
			Help: "Принятые заявки по источнику резюме: llm или digest.",
		}, []string{"summary_source"}),
		rateLimited: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "eb_rate_limited_total",
			Help: "Отказы по пределу частоты.",
		}, []string{"rule"}),
		rateStoreErrors: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "eb_rate_store_errors_total",
			Help: "Сбои общего хранилища пределов (Redis): предел считался в памяти реплики.",
		}, []string{"rule"}),
	}
	m.retentionPurged = prometheus.NewCounterVec(prometheus.CounterOpts{
		Name: "eb_retention_deleted_total",
		Help: "Строки, удалённые по сроку хранения персональных данных.",
	}, []string{"table"})
	reg.MustRegister(m.httpRequests, m.httpDuration, m.streams, m.chatOutcomes, m.leads,
		m.rateLimited, m.rateStoreErrors, m.retentionPurged)
	return m
}

// Handler — /metrics.
func (m *Metrics) Handler() http.Handler {
	return promhttp.HandlerFor(m.registry, promhttp.HandlerOpts{Registry: m.registry})
}

// ObserveHTTP — завершённый запрос. route — шаблон маршрута, а не путь:
// путь из запроса дал бы метрике столько рядов, сколько путей пришлёт
// любой сканер.
func (m *Metrics) ObserveHTTP(route, method string, status int, took time.Duration) {
	if m == nil {
		return
	}
	m.httpRequests.WithLabelValues(route, method, strconv.Itoa(status)).Inc()
	m.httpDuration.WithLabelValues(route, method).Observe(took.Seconds())
}

// StreamOpened и StreamClosed — открытые потоки ответа.
func (m *Metrics) StreamOpened() {
	if m != nil {
		m.streams.Inc()
	}
}

func (m *Metrics) StreamClosed() {
	if m != nil {
		m.streams.Dec()
	}
}

// ChatOutcome — исход ответа.
func (m *Metrics) ChatOutcome(outcome, mode string) {
	if m == nil {
		return
	}
	if mode == "" {
		mode = "default"
	}
	m.chatOutcomes.WithLabelValues(outcome, mode).Inc()
}

// Lead — принятая заявка.
func (m *Metrics) Lead(summarySource string) {
	if m != nil {
		m.leads.WithLabelValues(summarySource).Inc()
	}
}

// RateLimited — отказ по пределу.
func (m *Metrics) RateLimited(rule string) {
	if m != nil {
		m.rateLimited.WithLabelValues(rule).Inc()
	}
}

// RateStoreError — сбой общего хранилища пределов.
func (m *Metrics) RateStoreError(rule string) {
	if m != nil {
		m.rateStoreErrors.WithLabelValues(rule).Inc()
	}
}

// RetentionPurged — удалено по сроку хранения.
func (m *Metrics) RetentionPurged(leads, answers, feedback int64) {
	if m == nil {
		return
	}
	m.retentionPurged.WithLabelValues("leads").Add(float64(leads))
	m.retentionPurged.WithLabelValues("answers").Add(float64(answers))
	m.retentionPurged.WithLabelValues("feedback").Add(float64(feedback))
}
