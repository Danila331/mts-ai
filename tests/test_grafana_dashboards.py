"""Дашборды Grafana (monitoring/grafana/): структура и метрики в PromQL.

Без docker и promtool: проверяется, что JSON разбирается, у панелей есть
запросы к источнику Prometheus, а каждое имя метрики в выражениях есть
среди метрик, которые реально экспортируются, — иначе панель молча
останется пустой.
"""
import json
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
GRAFANA = ROOT / "monitoring" / "grafana"
METRICS_GO = ROOT / "backend" / "internal" / "metrics" / "metrics.go"

# Метрики шлюза LiteLLM Proxy (callbacks: ["prometheus"], llm-gateway/config.yaml,
# версия в llm-gateway/Dockerfile). Источник — документация LiteLLM
# «Prometheus metrics» (docs.litellm.ai/docs/proxy/prometheus); счётчики на
# выходе клиента Prometheus получают суффикс _total, гистограммы — _bucket.
# Обновляя версию шлюза, сверьте список с /metrics живого шлюза.
LITELLM_METRICS = {
    "litellm_proxy_total_requests_metric_total",
    "litellm_proxy_failed_requests_metric_total",
    "litellm_input_tokens_metric_total",
    "litellm_output_tokens_metric_total",
    "litellm_total_tokens_metric_total",
    "litellm_spend_metric_total",
    "litellm_request_total_latency_metric_bucket",
    "litellm_llm_api_latency_metric_bucket",
    "litellm_deployment_failure_responses_total",
    "litellm_deployment_successful_fallbacks_total",
    "litellm_deployment_failed_fallbacks_total",
    "litellm_deployment_cooled_down_total",
}

PROMQL_WORDS = {
    "sum", "rate", "increase", "histogram_quantile", "by", "without", "le",
    "avg", "max", "min", "count", "on", "ignoring", "and", "or", "unless",
    "irate", "label_replace", "clamp_min", "clamp_max", "topk", "bottomk",
}
SELECTOR = re.compile(r"([a-zA-Z_:][a-zA-Z0-9_:]*)\s*(\{[^}]*\})?")


def api_metrics():
    """Имена eb_* из backend/internal/metrics/metrics.go с суффиксами Prometheus."""
    src = METRICS_GO.read_text(encoding="utf-8")
    names = set()
    for kind, name in re.findall(r"(Counter|Gauge|Histogram)Opts\{\s*Name:\s*\"([a-z0-9_]+)\"", src):
        if kind == "Histogram":
            names |= {name + "_bucket", name + "_sum", name + "_count"}
        else:
            names.add(name)
    return names


def metric_names(expr):
    """Имена метрик из выражения: слова вне {…}, [...], строк и функций."""
    expr = re.sub(r'"[^"]*"', '""', expr)
    expr = re.sub(r"\[[^\]]*\]", "", expr)
    expr = re.sub(r"\b(by|without|on|ignoring)\s*\([^)]*\)", "", expr)
    found = set()
    for word, _ in SELECTOR.findall(re.sub(r"\{[^}]*\}", "{}", expr)):
        if word in PROMQL_WORDS or re.fullmatch(r"[0-9.]+", word):
            continue
        found.add(word)
    return found


def dashboards():
    return sorted((GRAFANA / "dashboards").glob("*.json"))


class DashboardsTest(unittest.TestCase):
    def test_api_metrics_parsed(self):
        names = api_metrics()
        self.assertIn("eb_chat_answers_total", names)
        self.assertIn("eb_http_request_duration_seconds_bucket", names)
        self.assertIn("eb_chat_streams_in_flight", names)

    def test_three_dashboards(self):
        self.assertEqual(
            {p.name for p in dashboards()},
            {"consultant.json", "model-gateway.json", "leads.json"},
        )

    def test_structure(self):
        uids = set()
        for path in dashboards():
            with self.subTest(path.name):
                d = json.loads(path.read_text(encoding="utf-8"))
                self.assertTrue(d["title"])
                self.assertTrue(d["uid"])
                self.assertNotIn(d["uid"], uids)
                uids.add(d["uid"])
                self.assertTrue(d["panels"])
                ids = [p["id"] for p in d["panels"]]
                self.assertEqual(len(ids), len(set(ids)), "id панелей повторяются")
                for p in d["panels"]:
                    self.assertTrue(p["title"])
                    self.assertEqual(p["datasource"]["uid"], "prometheus")
                    self.assertTrue(p["targets"], p["title"])
                    for t in p["targets"]:
                        self.assertEqual(t["datasource"]["uid"], "prometheus")
                        self.assertTrue(t["expr"].strip())
                    g = p["gridPos"]
                    self.assertLessEqual(g["x"] + g["w"], 24)

    def test_metrics_exist(self):
        known = api_metrics() | LITELLM_METRICS
        for path in dashboards():
            d = json.loads(path.read_text(encoding="utf-8"))
            for p in d["panels"]:
                for t in p["targets"]:
                    with self.subTest(f"{path.name}: {p['title']}"):
                        names = metric_names(t["expr"])
                        self.assertTrue(names, t["expr"])
                        self.assertLessEqual(names, known, t["expr"])

    def test_expressions_balanced(self):
        for path in dashboards():
            d = json.loads(path.read_text(encoding="utf-8"))
            for p in d["panels"]:
                for t in p["targets"]:
                    e = t["expr"]
                    for a, b in ("()", "{}", "[]"):
                        self.assertEqual(e.count(a), e.count(b), e)

    def test_provisioning(self):
        ds = (GRAFANA / "provisioning" / "datasources" / "prometheus.yml").read_text(encoding="utf-8")
        self.assertIn("uid: prometheus", ds)
        prov = (GRAFANA / "provisioning" / "dashboards" / "dashboards.yml").read_text(encoding="utf-8")
        self.assertIn("/var/lib/grafana/dashboards", prov)

    def test_image_pinned_by_digest_and_consistent(self):
        compose = (ROOT / "compose.yaml").read_text(encoding="utf-8")
        docker = (GRAFANA / "Dockerfile").read_text(encoding="utf-8")
        pin = re.compile(r"grafana/grafana:[0-9][0-9.]*@sha256:[0-9a-f]{64}")
        in_compose = pin.search(compose)
        in_docker = pin.search(docker)
        self.assertTrue(in_compose and in_docker)
        self.assertEqual(in_compose.group(0), in_docker.group(0))

    def test_grafana_requires_password(self):
        # Не admin/admin: пароль из окружения, а без него — пароль разработки (стенд одной командой, T28).
        compose = (ROOT / "compose.yaml").read_text(encoding="utf-8")
        self.assertIn("GF_SECURITY_ADMIN_PASSWORD: ${GF_SECURITY_ADMIN_PASSWORD:-", compose)
        self.assertNotIn("GF_SECURITY_ADMIN_PASSWORD: ${GF_SECURITY_ADMIN_PASSWORD:-admin}", compose)
        self.assertIn('"127.0.0.1:${EB_GRAFANA_PORT:-3001}:3000"', compose.replace("[", "").replace("]", ""))
        self.assertIn('GF_AUTH_ANONYMOUS_ENABLED: "false"', compose)


if __name__ == "__main__":
    unittest.main()
