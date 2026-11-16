package core

import (
	"fmt"
	"sync"
	"time"
)

// ErrCircuitOpen — ядро недавно подряд не отвечало, и вызов отклонён без
// попытки: клиент получает быстрый понятный отказ, а лежащее ядро не
// копит очередь ожидающих запросов. Это частный случай ErrUnavailable.
var ErrCircuitOpen = fmt.Errorf("%w: предохранитель открыт", ErrUnavailable)

// Breaker — минимальный предохранитель: после failures неудач подряд
// размыкается на cooldown, затем пропускает один пробный вызов
// (полуоткрытое состояние). Успех пробы замыкает его, неудача — размыкает
// снова. Своя реализация вместо библиотеки: нужны только эти три
// состояния, а лишняя зависимость — лишняя поверхность для govulncheck.
type Breaker struct {
	failures int
	cooldown time.Duration
	now      func() time.Time

	mu       sync.Mutex
	count    int       // неудачи подряд
	openedAt time.Time // не нулевое — предохранитель разомкнут
	probing  bool      // пробный вызов уже в пути
}

// NewBreaker: failures <= 0 выключает предохранитель.
func NewBreaker(failures int, cooldown time.Duration) *Breaker {
	if cooldown <= 0 {
		cooldown = 15 * time.Second
	}
	return &Breaker{failures: failures, cooldown: cooldown, now: time.Now}
}

// Allow решает, пускать ли вызов. Пущенный вызов обязан сообщить итог
// через Done.
func (b *Breaker) Allow() error {
	if b == nil || b.failures <= 0 {
		return nil
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.openedAt.IsZero() {
		return nil
	}
	if b.now().Sub(b.openedAt) < b.cooldown || b.probing {
		return ErrCircuitOpen
	}
	b.probing = true
	return nil
}

// Done сообщает итог пущенного вызова: ok — ядро ответило (пусть отказом
// по запросу, 4xx), иначе — недоступно.
func (b *Breaker) Done(ok bool) {
	if b == nil || b.failures <= 0 {
		return
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	b.probing = false
	if ok {
		b.count, b.openedAt = 0, time.Time{}
		return
	}
	b.count++
	if b.count >= b.failures || !b.openedAt.IsZero() {
		b.openedAt = b.now()
	}
}

// Open — предохранитель разомкнут и пробный вызов ещё не разрешён.
func (b *Breaker) Open() bool {
	if b == nil || b.failures <= 0 {
		return false
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	return !b.openedAt.IsZero() && b.now().Sub(b.openedAt) < b.cooldown
}
