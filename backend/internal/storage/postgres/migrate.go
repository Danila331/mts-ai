package postgres

import (
	"errors"
	"fmt"

	"github.com/golang-migrate/migrate/v4"
	_ "github.com/golang-migrate/migrate/v4/database/pgx/v5"
	"github.com/golang-migrate/migrate/v4/source/iofs"

	"github.com/Danila331/mts-ai/backend/migrations"
)

// Migrate накатывает схему до последней версии.
//
// Схема накатывается самой службой, а не рукой при выкладке: у базы на
// хостинге нет публичного адреса, и ручной шаг однажды забудут — а
// обнаружится это на первой заявке клиента.
//
// Параллельный запуск безопасен: migrate берёт блокировку в самой
// базе, поэтому вторая реплика дождётся первую, а не накатит поверх.
func Migrate(dsn string) error {
	src, err := iofs.New(migrations.FS, ".")
	if err != nil {
		return fmt.Errorf("миграции: %w", err)
	}
	m, err := migrate.NewWithSourceInstance("iofs", src, pgx5URL(dsn))
	if err != nil {
		return fmt.Errorf("миграции: %w", err)
	}
	defer func() { _, _ = m.Close() }()

	if err := m.Up(); err != nil && !errors.Is(err, migrate.ErrNoChange) {
		return fmt.Errorf("миграции: %w", err)
	}
	return nil
}

// pgx5URL переводит обычный адрес базы в схему драйвера migrate.
//
// Драйвер pgx/v5 у migrate регистрируется под схемой pgx5://, а Railway
// и все остальные отдают postgres:// или postgresql://. Без перевода
// migrate отвечает «unknown driver», и служба не стартует.
func pgx5URL(dsn string) string {
	for _, prefix := range []string{"postgresql://", "postgres://"} {
		if len(dsn) >= len(prefix) && dsn[:len(prefix)] == prefix {
			return "pgx5://" + dsn[len(prefix):]
		}
	}
	return dsn
}
