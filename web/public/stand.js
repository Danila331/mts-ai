/*
 * Тег виджета для стенда «виджет на сайте МТС» (web/scripts/stand.mjs).
 *
 * Стенд подключает этот файл с того же адреса, что и widget.js, а не зашивает тег в свою копию сайта.
 * Поэтому всё, что касается виджета, — сам виджет, его умолчания и разбор настроек превью — приезжает на
 * стенд вместе с каждой выкладкой стенда EnergyTool AI, и стенд сайта МТС не нужно пересобирать.
 *
 * Настройки превью приходят в адресе страницы: ?w_title=…&w_color=…&w_position=…&w_greeting=…
 * &w_greetingDelay=…&w_quick=a|b&w_topics={"/solar":"solar"}&w_path=/solar. Чего нет в адресе, то виджет берёт из своих умолчаний — ровно как на
 * сайте клиента с тегом без настроек. ?w_preview=1 заново показывает подсказку у кнопки и принимает
 * команды ask/toggle от страницы /widget (iframe с другого origin не может вызвать EnergyToolChat напрямую).
 */
(function () {
  var self = document.currentScript;
  if (!self || window.EnergyToolChat) return;
  var origin = new URL(self.src, location.href).origin;
  var params = new URLSearchParams(location.search);

  if (params.get("w_preview")) {
    try {
      sessionStorage.removeItem("energytool-chat:greeted");
      sessionStorage.removeItem("energytool-chat:open");
    } catch {
      /* хранилище недоступно — подсказка просто не покажется повторно */
    }
    addEventListener("message", function (e) {
      // Команды — только от страницы /widget того же стенда EnergyTool AI.
      if (e.origin !== origin || !e.data || e.data.type !== "eb:preview") return;
      var chat = window.EnergyToolChat;
      if (!chat) return;
      if (e.data.action === "ask") chat.ask(String(e.data.text || ""));
      if (e.data.action === "toggle") chat.toggle();
    });
  }

  // ?w_path=/solar — превью страницы с темой: виджет видит этот путь (адрес меняется без перезагрузки).
  var path = params.get("w_path");
  if (path && /^\/[^\s"'<>]{0,199}$/.test(path)) {
    try {
      history.replaceState(null, "", path);
    } catch {
      /* не тот origin или запрет — превью покажет главную */
    }
  }

  var tag = document.createElement("script");
  tag.async = true;
  // Без кэша: превью должно показывать виджет из последней выкладки, а не из кэша браузера.
  tag.src = origin + "/widget.js?v=" + Date.now();
  ["title", "color", "position", "greeting", "greetingDelay", "quick", "topics"].forEach(function (key) {
    var value = params.get("w_" + key);
    if (value === null) return;
    if (key === "color" && !/^#[0-9a-f]{3,8}$/i.test(value)) return;
    tag.setAttribute("data-" + key.replace(/[A-Z]/g, function (c) { return "-" + c.toLowerCase(); }), value);
  });
  document.body.appendChild(tag);
})();
