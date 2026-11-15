package session

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/Danila331/mts-ai/backend/internal/apperr"
)

func TestParseRole(t *testing.T) {
	for _, c := range []struct {
		role, source string
		want         RoleHint
	}{
		{"", "", RoleHint{}},
		{"", "auto", RoleHint{}},
		{"", "client", RoleHint{Source: RoleByClient}},
		{"grid", "auto", RoleHint{Role: RoleGrid, Source: RoleAuto}},
		{"grid", "client", RoleHint{Role: RoleGrid, Source: RoleByClient}},
		{" housing ", "", RoleHint{Role: RoleHousing, Source: RoleByClient}},
		{"mts_manager", "client", RoleHint{Role: RoleMTSManager, Source: RoleByClient}},
		{"warehouse", "auto", RoleHint{Role: RoleWarehouse, Source: RoleAuto}},
	} {
		got, err := ParseRole(c.role, c.source)
		require.NoError(t, err, c)
		assert.Equal(t, c.want, got, c)
	}
	for _, c := range [][2]string{{"admin", ""}, {"Grid", "client"}, {"grid", "model"}, {"", "guess"}} {
		_, err := ParseRole(c[0], c[1])
		inv, ok := apperr.AsInvalid(err)
		require.True(t, ok, c)
		assert.NotEmpty(t, inv.Msg, c)
	}
	_, err := ParseRole("admin", "")
	inv, _ := apperr.AsInvalid(err)
	assert.Equal(t, "role: одна из business, engineer, housing, grid, mts_manager, industry, supplier, utility, landlord, retail, warehouse", inv.Msg)
}

func TestRolesAreKnown(t *testing.T) {
	seen := map[Role]bool{}
	for _, r := range Roles {
		assert.True(t, r.Known())
		assert.False(t, seen[r], "без повторов")
		seen[r] = true
	}
	assert.Len(t, Roles, 11)
	for _, rr := range roleRules {
		assert.True(t, rr.role.Known(), rr.role)
	}
	assert.False(t, Role("").Known())
}

// Те же фразы — в web/src/lib/roles.test.ts: словарь фронта и службы
// должен давать одну роль.
var detectCases = []struct {
	text string
	want Role
}{
	{"Мы электросетевая компания, хотим находить потери", RoleGrid},
	{"Мы — территориальная сетевая организация, 40 тысяч абонентов", RoleGrid},
	{"Я председатель СНТ, платим за свет больше, чем потребляем", RoleHousing},
	{"У нас в СНТ платим за свет больше, чем потребляем. Что можно сделать?", RoleHousing},
	{"Мы управляющая компания, 12 домов", RoleHousing},
	{"У нас завод, хотим снизить расходы на электричество", RoleIndustry},
	{"Мы небольшой завод. С чего начать?", RoleIndustry},
	{"Я главный энергетик комбината", RoleEngineer},
	{"Работаю энергетиком на заводе", RoleEngineer},
	{"Я региональный менеджер МТС, клиент спрашивает про оптовый рынок", RoleMTSManager},
	{"Мой клиент — сеть магазинов", RoleMTSManager},
	{"Мы энергосбытовая компания. Подойдёт ли нам поиск потерь?", RoleSupplier},
	{"Мы водоканал, хотим собирать показания", RoleUtility},
	{"У нас торговый центр, арендаторы платят по субсчётчикам", RoleLandlord},
	{"Бизнес-центр на 30 арендаторов", RoleLandlord},
	{"У нас сеть кофеен в трёх городах", RoleRetail},
	{"Окупится ли солнечная станция на крыше нашего склада?", RoleWarehouse},
	{"Мы малый бизнес, ИП, платим много за свет", RoleBusiness},
	// Третьи лица и общие вопросы — не роль.
	{"Сетевая компания отключила нам свет на сутки", ""},
	{"Наш гарантирующий поставщик поднял цену", ""},
	{"Хотим автоматически собирать показания со счётчиков на 40 объектах", ""},
	{"Можно ли сложить мощность нескольких площадок?", ""},
	{"Чем занимается энергетика МТС?", ""},
	{"", ""},
}

func TestDetectRole(t *testing.T) {
	for _, c := range detectCases {
		assert.Equal(t, c.want, DetectRole([]string{c.text}), c.text)
	}
	// Первая реплика, где клиент сказал о себе, решает; общие вопросы до неё
	// роли не дают.
	assert.Equal(t, RoleGrid, DetectRole([]string{
		"Что такое поиск коммерческих потерь?", "Мы сетевая компания", "А склад у нас тоже есть",
	}))
	assert.Equal(t, Role(""), DetectRole(nil))
}

func TestRoleFromOrgType(t *testing.T) {
	for text, want := range map[string]Role{
		"электросетевая компания": RoleGrid,
		"сетевая организация":     RoleGrid,
		"энергосбытовая компания": RoleSupplier,
		"СНТ":            RoleHousing,
		"ТСЖ":            RoleHousing,
		"торговый центр": RoleLandlord,
		"склад":          RoleWarehouse,
		"производственное предприятие": RoleIndustry,
		"ООО":   RoleBusiness,
		"школа": "",
		"":      "",
	} {
		assert.Equal(t, want, RoleFromOrgType(text), text)
	}
}
