# Kiến trúc hệ thống (v2.56.0)

## Mục lục

- #1-domain-layer
- #2-infrastructure-layer
- #3-shared-services
- #4-engine-layer
  - #41-engine-cơ-sở
  - #42-matchengine
  - #43-catalog--engine-phụ-trợ
  - #44-nguyên-tắc-vận-hành
- #5-network-layer
- #6-ui-layer
- #7-application-layer
- #8-coordinator-priority
- #9-tông-chiến
- #10-đấu-pháp-pvpengine
- #11-boss-engine
- #12-chế-độ-boss-nâng-cao
- #13-u-minh---tầm-bảo---xuất-hồn
- #14-hpmp-gate
- #15-skill-queue--skill-gate
- #16-tự-động-đổi-chiêu-khắc-hệ
- #17-warengine-tông-chiến
- #18-requestqueue

---

# 1. Domain Layer

Business logic thuần, không side-effect.

## Thành phần

### ElementRules

Quy tắc khắc hệ.

### SkillSelector

Lựa chọn bộ chiêu phù hợp.

### CombatFormatter

Chuẩn hóa dữ liệu trận đánh.

### BossCatalog

Quản lý dữ liệu Boss:

- Danh sách boss
- Chọn boss
- Chế độ nâng cao:
  - `full`
  - `min70`
  - `dmg50`
  - `dmg25`

### MonsterCatalog

Quản lý dữ liệu quái.

### PillCatalog

Quản lý dữ liệu đan dược.

### AlchemyCatalog

Quản lý công thức và dữ liệu luyện đan.

### SkillCatalog

Quản lý toàn bộ sách chiêu.

Đọc định dạng mới:

```js
{
  skill_id,
  effects:[]
}
```

Suy luận:

- `skill_kind`
- `mp_cost`
- `element`

### GardenCatalog

Quản lý dữ liệu dược điền.

### UMinhPlanner

Thuật toán tìm đường trong U Minh Cốc.

---

# 2. Infrastructure Layer

Các thành phần nền tảng dùng chung.

## EventEmitter

Cơ chế pub/sub nội bộ.

## StateMachine

Khung quản lý trạng thái.

## RateLimiter

Giới hạn tốc độ thao tác.

## Coordinator

Bộ điều phối trung tâm.

Quản lý:

- Quyền ưu tiên
- Skill Gate
- Boss Lock
- PvP Lock
- Điều phối chế độ

## PillBook

Quản lý:

- Đan đang chọn
- Tồn kho
- Loại đan sử dụng

## Runtime Configuration

### HpPillConfig

Đan hồi HP.

### MpPillConfig

Đan hồi MP.

### HealSkillConfig

Ngưỡng dùng kỹ năng hồi máu.

### HpGate

Ngưỡng HP:

- Dừng
- Tiếp tục

### MpGate

Ngưỡng MP:

- Dừng
- Tiếp tục

### PillConfig

Cấu hình dùng cho nút:

```text
Hồi MP ngay
```

---

# 3. Shared Services

## Healer

Dưỡng thương tự động.

## PillManager

Quản lý đan hồi MP.

Chức năng:

- Tự dùng đan
- Hồi MP ngay

## HpPillService

Quản lý đan hồi HP.

Chức năng:

- Tự dùng đan
- Hồi HP ngay

## SkillSwapper

Tự động đổi chiêu.

Áp dụng cho:

- Boss
- Tầm bảo
- Săn yêu

---

# 4. Engine Layer

Mỗi chế độ tương ứng một engine độc lập.

---

## 4.1. Engine cơ sở

```text
Engine (abstract)
```

### Engine độc lập

- BossEngine
- BreakthroughEngine
- AlchemyEngine
- BeastEngine
- GardenEngine
- XuatHonEngine

### MeridianEngine

Luyện thể:

- Chạy nền
- Chạy liên tục
- Tự chọn huyệt rẻ nhất

### PetEngine

- Vuốt ve yêu thú xuất chiến
- Chờ hồi 1 giờ

### WarEngine

- Tông Chiến
- Không sử dụng MatchEngine

---

## 4.2. MatchEngine

Khung chiến đấu dùng chung.

```text
MatchEngine
├─ FarmEngine
├─ HuntEngine
├─ TowerEngine
├─ UMinhEngine
└─ PvpEngine
```

### waitGate

Kiểm tra:

- HP
- MP

trước khi mở trận hoặc vào U Minh.

### waitMp

Xử lý hết MP giữa trận.

---

## 4.3. Catalog & Engine phụ trợ

- WarCatalog
- BreakthroughCatalog
- BeastCatalog
- XuatHonCatalog
- AutoLogin
- ModeMemory
- BulkUseCatalog
- BulkUseEngine
- SellCatalog
- SellEngine

---

## 4.4. Nguyên tắc vận hành

### Không thao tác DOM

Engine không được phép truy cập DOM.

### Chỉ phát sự kiện

```text
log
start
stop
state
status
tickets
```

và các event riêng theo từng chế độ.

### StateMachine

Mọi vòng lặp:

- Main loop
- Battle loop

đều dùng StateMachine.

### Retry

Không tự tắt chế độ khi lỗi.

Backoff:

```text
10s
→ 20s
→ 30s
→ 120s
```

Ngoại lệ:

| Engine | Retry |
|----------|----------|
| Boss | 2s |
| Breakthrough | 5s |

---

# 5. Network Layer

## GameApi

Lớp giao tiếp duy nhất với game.

### Chức năng

#### Hook Token

Theo dõi:

- fetch
- XMLHttpRequest

để lấy token.

#### REST API

Toàn bộ request đi qua:

```text
RequestQueue
```

#### Timeout Protection

Mỗi request:

```text
HTTP_TIMEOUT_MS
```

Khi quá hạn:

```text
request → error
```

để watchdog xử lý.

---

# 6. UI Layer

## Thành phần

### PanelView

Giao diện chính.

Nhiệm vụ:

- Render DOM
- Nhận thao tác người dùng
- Phát event

### DualSlider

Thanh trượt đôi.

### SingleSlider

Thanh trượt đơn.

### SafeStorage

Wrapper của localStorage.

---

## Hai giao diện

### Desktop

- Floating panel
- Kéo thả

### Mobile (`cp`)

- Drawer bên phải
- Thanh thu gọn
- Mode cards
- Settings riêng
- Status buttons
- Touch target ≥ 44px

Chuyển tự động:

```text
width <= 1100px
```

---

## DUAL_SPECS

Sinh động 4 nhóm điều khiển:

### Đan hồi HP

```text
Toggle + Range
```

### Đan hồi MP

```text
Toggle + Range
```

### Ngưỡng HP

```text
Toggle + Range
```

### Ngưỡng MP

```text
Toggle + Range
```

Dùng chung:

```js
dual()
showDual()
setDual()
```

---

## Hành Trang → Đan

Cho phép:

- Chọn đan HP
- Chọn đan MP

Thanh:

```text
Hồi ngay
```

được dùng cho:

- Hồi HP ngay
- Hồi MP ngay

---

# 7. Application Layer

Nối:

```text
Engine ↔ View
```

Thông qua các hàm `bind*`.

## Chức năng

### bindDual()

- Nạp dữ liệu
- Lưu dữ liệu
- Chuyển dữ liệu cũ
- Nối sự kiện

### Skill Queue

```js
queueSkill()
flushSkillQueue()
```

### Xuất Hồn

```js
xhBlockers
```

quyết định điều kiện được phép chạy.

---

# 8. Coordinator Priority

Thứ tự ưu tiên:

```text
Breakthrough
↓
Boss
↓
UMinh
↓
Hunt
↓
Tower
↓
Farm
↓
XuatHon
```

---

# 9. Tông Chiến

Lãnh địa hợp lệ:

- Đang chiếm (`ownerSectId`)
- Đã đăng ký và được duyệt

Thời điểm quét:

- Khi bật
- Mỗi `xx:25`
- Khi tới giờ tập hợp
- Mỗi phút nếu chưa thấy lãnh địa

Log:

- Đã sở hữu
- Có thể chiếm
- Bị tông khác chuẩn bị chiếm

---

# 10. Đấu Pháp (PvpEngine)

Chạy nền ở mức ưu tiên thấp nhất.

## Nhường quyền

- Boss
- Breakthrough
- UMinh
- Hunt
- Tower
- Trận Farm đang diễn ra

Không nhường theo:

```text
FarmEngine đang bật nhưng hết vé
```

## Quy tắc

- Chỉ challenge
- Có Elo
- Không phạt karma

Khoảng cách:

```text
PVP_GAP_MS >= 15s
```

## Chọn mục tiêu

Điều kiện:

```text
Target.level <= My.level - gap
```

Trong số đó:

```text
Chọn điểm cao nhất
```

Đủ số trận đặt trước:

```text
Tự tắt
```

Trong trận:

```js
coord.pvpBattle = true
```

Khóa:

- Đổi chiêu
- Đột phá

---

# 11. Boss Engine

Được ưu tiên trong:

```text
3 phút đầu mỗi giờ
```

Breakthrough:

- Có thể chen giữa trận
- Có thể chờ trận hiện tại kết thúc

Nếu:

```js
coord.bossPending = true
```

thì:

- U Minh không được vào
- Không mở lượt mới

Lý do:

Trong U Minh:

- HP không tự hồi
- MP không tự hồi

---

# 12. Chế độ Boss nâng cao

Lưu tại:

```js
BossEngine.st.modes
```

và localStorage.

---

## full

Đánh đến cùng.

---

## min70

Chỉ đánh nếu:

```text
Boss HP >= 70%
```

Kiểm tra:

- Lúc vào
- Trước mỗi đòn

Nếu thấp hơn:

```text
Dừng ngay
```

---

## dmg50 / dmg25

Khi:

```text
myDamage >= 50% hp_max
```

hoặc

```text
myDamage >= 25% hp_max
```

sẽ:

```js
st.paused = true
```

Nhả quyền boss.

Chuyển sang theo dõi Last Hit.

### Last Hit

Ngưỡng:

```text
BossCatalog.LAST_HIT = 2.5%
```

Khi boss xuống dưới ngưỡng:

```text
Đánh tiếp
```

Timeout:

```text
BOSS_LASTHIT_WAIT_MS
```

Quá hạn:

```js
st.gaveUp = true
```

### Chu kỳ quét

| HP Boss | Tần suất |
|-----------|-----------|
| >30% | 10s |
| 10%-30% | 3s |
| <10% | 2s |

---

# 13. U Minh - Tầm Bảo - Xuất Hồn

Không được chạy đồng thời.

```text
UMinh
Farm
XuatHon
```

### Điều kiện chạy Xuất Hồn

U Minh:

```text
Đã hoàn thành hoặc tắt
```

Farm:

```text
Hết vé hoặc tắt
```

Nếu Xuất Hồn đang chạy mà:

- Farm cần vào
- U Minh cần vào

=> abandon lượt hiện tại.

---

# 14. HP/MP Gate

Mỗi mode có:

- HP Gate riêng
- MP Gate riêng

Nếu:

```text
HP <= stop threshold
```

hoặc

```text
MP <= stop threshold
```

thì:

- Không mở trận mới
- U Minh không được vào

### Phục hồi

1. Dùng đan
2. Nếu hết đan:
   - Chờ hồi tự nhiên
3. Kiểm tra mỗi 2 phút
4. Khi vượt continue threshold:
   - Chạy tiếp

Boss không áp dụng.

---

# 15. Skill Queue & Skill Gate

Trong combat:

```text
Không đổi chiêu
```

Mọi yêu cầu đổi chiêu đi vào:

```js
queueSkill()
```

Được thực thi thông qua:

```js
flushSkillQueue()
```

và:

```js
coord.skillGate()
```

khi trận kết thúc.

---

# 16. Tự động đổi chiêu khắc hệ

Triển khai bởi:

- SkillSwapper
- SkillCatalog.plan()

Áp dụng:

- Boss
- Hunt
- Farm
- U Minh

Không áp dụng:

- Tower
- U Minh Cốc nội chiến
- War

## Nguồn hệ mục tiêu

### U Minh

```js
CFG.UM_ELEMENT_BY_REALM
```

### Farm

Monster có:

```text
monsterId lớn nhất
```

trong bí cảnh.

API:

```text
/api/dungeon/farm/zones/<code>/monsters
```

## Triết lý đổi chiêu

Nếu đã có chiêu khắc:

```text
Giữ nguyên
```

Nếu chưa có:

```text
Tìm trong ô dự bị
```

### Slot dự bị

- Kim
- Mộc
- Thủy
- Hỏa
- Thổ
- Heal

### Đổi tối thiểu

Ưu tiên:

1. Gắn vào ô trống
2. Nếu đầy:
   - Tháo chiêu yếu nhất
   - Gắn chiêu mới

Nếu lỗi:

```text
Khôi phục chiêu cũ
```

---

# 17. WarEngine (Tông Chiến)

Hoạt động độc lập.

Không sử dụng HP thật.

Không xung đột với mode khác.

## Trước tập hợp

```text
Chờ gatherAt
```

## Đến giờ tập hợp

Đổi chiêu 1 lần:

```js
SkillSwapper.ensureWar()
SkillCatalog.planWar()
```

Nguyên tắc:

- Heal mạnh nhất ×1
- Damage mạnh nhất ×N

Server lock bộ chiêu tại:

```text
POST garrison
```

nên đổi sau đó không còn tác dụng.

### Ưu tiên mục tiêu

```text
Enemy Player
↓
Guard
↓
Wait
```

Điều kiện:

```text
power <= CFG.WAR_MAX_POWER
```

Ưu tiên:

```text
Yếu nhất trước
```

### Một lượt

```text
POST attack
↓
POST match/action
↓
finished
```

### Điều kiện dừng

- Hết thời gian live
- Đạt maxAttacks

### Chọn lãnh địa

Ưu tiên:

```text
Chưa có
↓
Center
↓
Middle
↓
Outer
```

---

# 18. RequestQueue

Mọi request game đi qua đây.

## Priority

### P0 (Critical)

- Boss
- Breakthrough
- Skill Swap

### P1 (Gameplay)

- Farm
- Hunt
- Tower
- U Minh
- War
- Character Info

### P2 (Background)

- Bán đồ
- Mở rương
- Ấp trứng
- Tác vụ nền

---

## Aging

Nếu request chờ quá:

```text
REQ_AGING_MS
```

sẽ được nâng một mức ưu tiên.

---

## Anti Rate Limit

Nếu gặp:

- HTTP 429
- "too many requests"

thì:

1. Pause queue (`REQ_PAUSE_MS`)
2. Retry đúng 1 lần
