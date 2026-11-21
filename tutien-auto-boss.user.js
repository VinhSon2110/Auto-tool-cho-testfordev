// ==UserScript==
// @name         Tu Tiên - Auto Tool
// @namespace    autoboss.tutien
// @version      2.45.2
// @description  Tự động đánh boss, U Minh Cốc, săn yêu, leo tháp, tầm bảo và xuất hồn (ưu tiên: đột phá > boss > U Minh Cốc > săn yêu > leo tháp > tầm bảo > xuất hồn), kèm luyện đan, linh điền, yêu thú, đổi chiêu, đan hồi HP/MP và ngưỡng HP/MP theo từng chế độ; chỉ dùng chiêu (ưu tiên khắc hệ), tự hồi máu/chờ MP; hàng chờ giữ nhịp ~1 lệnh/giây; giao diện máy tính và màn hình nhỏ cảm ứng
// @match        https://www.testfordev.online/*
// @match        https://testfordev.online/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

/*
 * KIẾN TRÚC (cập nhật tới v2.45.2). Thứ tự trong file đi từ lớp thuần tới lớp phụ thuộc DOM / mạng:
 *
 *  1. Domain (thuần, không side-effect)  : ElementRules, SkillSelector, CombatFormatter, BossCatalog (chọn boss + chế độ nâng cao theo cỡ boss: full / min70 / dmg50 / dmg25), MonsterCatalog, PillCatalog, AlchemyCatalog,
 *                                          SkillCatalog (sách chiêu; đọc định dạng mới skill_id + effects[] và suy ra skill_kind / mp_cost / hệ cho phần còn lại),
 *                                          GardenCatalog, UMinhPlanner (tìm bước đi U Minh Cốc)
 *  2. Hạ tầng                            : EventEmitter, StateMachine, RateLimiter, Coordinator (cờ ưu tiên + skillGate), PillBook (đan đang chọn + tồn kho),
 *                                          cấu hình theo từng chế độ (đọc trực tiếp, UI sửa tại chỗ): HpPillConfig (đan hồi HP), MpPillConfig (đan hồi MP),
 *                                          HealSkillConfig (mức dùng chiêu hồi máu), MpGate / HpGate (ngưỡng tạm dừng / chạy tiếp của tầm bảo, săn yêu, leo tháp, U Minh Cốc);
 *                                          PillConfig (cấu hình dự phòng cho nút "Hồi MP ngay"),
 *                                          RequestQueue (hàng chờ lệnh gọi game: hai lệnh cách nhau >= REQ_GAP_MS (~1s), 3 mức ưu tiên + nâng mức khi chờ lâu, gộp GET trùng, dừng khi server báo gọi quá nhiều)
 *  3. Dịch vụ dùng chung                 : Healer (dưỡng thương), PillManager (đan hồi MP theo chế độ + nút Hồi MP ngay), HpPillService (đan hồi HP theo chế độ + nút Hồi HP ngay),
 *                                          SkillSwapper (tự đổi chiêu khắc hệ, chỉ trước boss)
 *  4. Engine (mỗi chế độ = 1 class)      : Engine (abstract)
 *                                            ├─ BossEngine, BreakthroughEngine, AlchemyEngine, BeastEngine, GardenEngine, XuatHonEngine, WarEngine (Tông Chiến, vòng lặp thường, không dùng MatchEngine)
 *                                            └─ MatchEngine (khung trận đánh dùng chung: waitGate = ngưỡng HP / MP trước khi mở trận hoặc vào U Minh, waitMp = hết MP giữa trận)
 *                                               → FarmEngine (tầm bảo), HuntEngine (săn yêu), TowerEngine (leo tháp), UMinhEngine (U Minh Cốc)
 *       Đi kèm trong phần này: WarCatalog (chọn lãnh địa, lọc mục tiêu, mốc xx:25 và 20:55), BreakthroughCatalog, BeastCatalog, XuatHonCatalog, AutoLogin, ModeMemory (nhớ chế độ để tự bật lại), BulkUseCatalog / BulkUseEngine (mở nhiều), SellCatalog / SellEngine (bán đồ)
 *       - Engine KHÔNG đụng DOM: chỉ phát sự kiện 'log' | 'start' | 'stop' | 'state' | 'status' | 'tickets' (và vài sự kiện riêng của từng chế độ)
 *       - Vòng lặp chính và vòng lặp trận đánh là các StateMachine (bảng chuyển trạng thái khai báo rõ ràng, vd. XuatHonEngine.TRANSITIONS)
 *       - Mọi lỗi đều không tự tắt chế độ: chờ lùi 10 / 20 / 30s rồi 120s (boss cố định 2s, đột phá cố định 5s)
 *  5. Hạ tầng mạng                       : GameApi (bắt token bằng hook fetch / XHR, gọi REST; MỌI lệnh đi qua RequestQueue, mức ưu tiên chọn theo đường dẫn;
 *                                          mỗi lệnh có giới hạn HTTP_TIMEOUT_MS, quá hạn thì thành lỗi để cơ chế lùi / watchdog xử lý, không để chế độ đứng im)
 *  6. UI                                 : PanelView (DOM thuần, phát sự kiện ý định của người dùng), DualSlider (thanh trượt đôi), SingleSlider (thanh đơn "Hồi ngay"), SafeStorage
 *       - Hai giao diện dùng chung một bộ phần tử và id: giao diện máy tính (bảng nổi, kéo được) và giao diện màn hình nhỏ cảm ứng
 *         (class "cp": ngăn kéo bên phải + thanh thu gọn + thẻ chế độ + trang cài đặt riêng; dải trạng thái hiện mỗi chế độ đang chạy thành một nút, chạm để tắt; ngưỡng HP / MP của từng chế độ nằm trong mục gập "Ngưỡng HP / MP · hồi máu"; vùng chạm tối thiểu 44px). Tự chọn theo độ rộng màn (<= 1100px), nút ở thanh tiêu đề để đổi tay
 *       - Bốn bộ "ô tích + thanh trượt đôi x% – y%" theo từng chế độ (đan hồi HP, đan hồi MP, ngưỡng MP, ngưỡng HP) khai báo trong DUAL_SPECS,
 *         dựng HTML, nối sự kiện (<ev>:toggle, <ev>:range) và đặt giá trị bằng cùng một mã (dual / showDual / setDual)
 *       - Tab Hành trang, mục "Đan": chọn loại đan HP / MP, thanh "Hồi ngay" dùng chung cho nút "Hồi MP ngay" và "Hồi HP ngay"
 *  7. App (controller)                   : nối engine <-> view bằng sự kiện (các hàm bind*; bindDual nạp / lưu / nối sự kiện cho 4 bộ trên, có chuyển dữ liệu cũ),
 *                                          lệnh đổi chiêu chờ (queueSkill / flushSkillQueue), điều kiện chạy của xuất hồn (xhBlockers)
 *
 *  THỨ TỰ ƯU TIÊN (Coordinator): đột phá > boss > U Minh Cốc > săn yêu > leo tháp > tầm bảo > xuất hồn.
 *  - Boss chiếm 3 phút đầu mỗi giờ; đột phá chen vào giữa các trận (btPause) và có thể đợi trận đang dở.
 *  - Còn boss và đang bật chế độ boss (coord.bossPending): U Minh Cốc không vào và không mở lượt mới, vì trong U Minh HP, MP không tự hồi theo thời gian (đan vẫn dùng được).
 *  - Chế độ nâng cao của từng cỡ boss (BossEngine.st.modes, lưu localStorage, mặc định full = đánh tới cùng):
 *      min70 = chỉ đánh khi boss còn >= 70% HP: xét cả lúc vào lẫn trước mỗi đòn (sCheck), tụt dưới 70% là dừng ngay kể cả đang đánh, không phụ thuộc F5;
 *      dmg50 / dmg25 = sát thương của bạn (myDamage) đạt 50% / 25% hp_max thì tạm dừng (st.paused), nhả coord.boss cho các chế độ khác,
 *      quét boss chờ còn <= BossCatalog.LAST_HIT (2,5% HP) rồi đánh tiếp để giành last hit. Chờ tối đa BOSS_LASTHIT_WAIT_MS thì bỏ boss đó (st.gaveUp).
 *      Lúc chờ, coord.bossPending vẫn bật nên U Minh Cốc không vào; các chế độ khác chạy. Tần suất quét: trên 30% HP mỗi 10s, 10-30% mỗi 3s, dưới 10% mỗi 2s.
 *      Đang đánh boss khác mà boss chờ last hit tới mốc thì sCheck (3s một lần) nhường và pick chọn boss đó trước.
 *  - U Minh Cốc, tầm bảo, xuất hồn không chạy song song nhau (quy tắc game). Xuất hồn chỉ bắt đầu khi U Minh Cốc đã đi xong (hoặc tắt) và tầm bảo hết vé (hoặc tắt);
 *    xuất hồn đang chạy dở mà U Minh Cốc / tầm bảo cần vào thì BỎ lượt đó (abandon, mất thưởng). Xuất hồn không đụng tới boss / săn yêu / leo tháp.
 *  - Ngưỡng HP / MP (mỗi chế độ, mỗi ngưỡng một ô bật / tắt): HP hoặc MP <= mức tạm dừng thì không mở trận mới (U Minh Cốc: không vào); dùng đan của chế độ đó
 *    (nếu bật) tới ít nhất mức chạy tiếp, không có đan thì chờ tự hồi, kiểm tra lại mỗi 2 phút, chạy tiếp khi vượt mức chạy tiếp. Boss không có ngưỡng này.
 *  - Đổi chiêu: lệnh bị hoãn khi đang trong trận; các chế độ gọi coord.skillGate() giữa hai trận để đổi ngay trước khi mở trận mới.
 *  - Tự đổi chiêu khắc hệ (SkillSwapper + SkillCatalog.plan) chỉ chạy trước boss: bộ chiêu đang gắn đã có chiêu công kích khắc thì giữ nguyên; nếu chưa có thì mới tìm
 *    trong chiêu dự bị (ô "Chiêu dùng để thay"), trống thì không tìm. Đổi tối thiểu (còn ô trống chỉ gắn thêm, hết ô thì tháo 1 chiêu yếu nhất rồi gắn);
 *    gắn lỗi sau khi đã tháo thì gắn lại chiêu vừa tháo. Leo tháp không đổi chiêu.
 *  - Tông Chiến (WarEngine, chỉ chạy khi bật; trận mô phỏng nên không đụng HP thật, không xung đột với các chế độ khác): trước gatherAt chờ; từ gatherAt đổi chiêu một lần
 *    (SkillSwapper.ensureWar + SkillCatalog.planWar: 1 chiêu hồi máu mạnh nhất + các chiêu công kích mạnh nhất, vì server chụp bộ chiêu lúc POST garrison và khóa tới hết sự kiện,
 *    đổi giữa trận vô ích) rồi vào lãnh địa; trong khung liveStartAt - liveEndAt mỗi lượt: người chơi khác tông có power <= CFG.WAR_MAX_POWER (không giới hạn lượt, yếu nhất trước)
 *    > thủ vệ (guard.remaining > 0, tối đa 5 lần thắng) > chờ người chơi xuất hiện. Một lượt = POST attack mở trận + POST match/action lặp tới finished. Chờ nextActionAt / woundedUntil
 *    giữa các lượt; dừng khi hết giờ live hoặc attacksMade >= limits.maxAttacks. Lãnh địa: chỉ liệt kê lãnh địa tông đã đăng ký, mặc định vòng cao trước (center > middle > outer),
 *    quét khi bật và mỗi xx:25; lựa chọn tay được giữ tới 20:55 rồi về mặc định (lưu localStorage). Đã garrison thì lãnh địa lấy từ me.garrison.
 *  - Hàng chờ lệnh (RequestQueue): ưu tiên 0 = boss, đột phá, đổi chiêu; 1 = tầm bảo, săn yêu, leo tháp, U Minh Cốc, Tông Chiến, thông tin nhân vật; 2 = việc nền (bán đồ, mở rương, ấp trứng...).
 *    Lệnh chờ quá REQ_AGING_MS thì được nâng một mức. Gặp 429 / "too many requests": dừng hàng REQ_PAUSE_MS rồi gửi lại đúng 1 lần.
 */
(function () {
  'use strict';

  const VERSION = '2.45.2'; // phải khớp với @version ở trên; nhớ tăng khi có thay đổi mới

  /* ===================== CẤU HÌNH ===================== */
  const CFG = {
    MIN_GAP_MS: 5000,          // mặc định chung (yêu cầu >= 5s), dùng khi engine không khai báo riêng
    BOSS_MIN_GAP_MS: 5000,     // tối thiểu giữa 2 đòn của BOSS
    BOSS_SKILL_REFRESH_LEAD_MS: 1000, // boss: đọc lại bộ chiêu trước lúc đánh chừng này (mặc định: đánh xong 4s thì đọc chiêu, 1s sau đánh)
    MATCH_MIN_GAP_MS: 2000,    // tối thiểu giữa 2 đòn của TẦM BẢO, SĂN YÊU và LEO THÁP
    TOWER_MAX_LOSSES: 5,       // leo tháp: thua liên tiếp chừng này lần thì tự dừng
    JITTER_MS: [500, 800],     // cộng thêm ngẫu nhiên để giống người
    IDLE_POLL_MS: 30000,       // chờ boss mới khi không có boss để đánh
    BOSS_PRIORITY_WINDOW_MS: 180000, // 3 phút đầu giờ (khi auto boss bật): chỉ đột phá / quét boss / thu hoạch linh điền / luyện đan
    BOSS_WINDOW_POLL_MS: 10000,      // quét boss mỗi 10s trong 3 phút đó
    BOSS_ERROR_RETRY_MS: 2000,       // boss lỗi: không tắt, thử lại sau 2s (cố định)
    BOSS_SPAWN_WINDOW_MS: 1200000, // boss xuất hiện đầu mỗi giờ: chỉ quét trong 20 phút đầu giờ, hết hạn thì nghỉ tới đầu giờ sau
    // Mọi chế độ (trừ boss) lỗi thì KHÔNG tự tắt: chờ lần lượt các mốc này, hết mốc thì giữ ERR_BACKOFF_CAP_MS; 1 lần thành công là về mốc đầu
    ERR_BACKOFF_STEPS_MS: [10000, 20000, 30000],
    ERR_BACKOFF_CAP_MS: 120000,
    NOSKILL_WAIT_MS: 30000,          // không có chiêu tấn công nào trong bộ chiêu: chờ chừng này rồi đọc lại chiêu + MP
    NOSKILL_LOG_EVERY_MS: 180000,    // nhắc trong log tối đa mỗi chừng này
    BAG_FULL_WAIT_MS: 60000,         // túi đầy: tạm dừng đánh mới, kiểm tra lại mỗi chừng này
    CONFIG_WAIT_MS: 60000,           // thiếu cấu hình (chưa chọn đan / hạt giống, đan bị khóa...): chờ rồi đọc lại
    EXPLORE_PAUSE_MS: [1000, 2000], // nghỉ ngắn trước khi vào trận tầm bảo mới
    // Tầm bảo: MP <= 20% thì tạm dừng, kiểm tra lại mỗi 2 phút, MP > 50% thì chạy tiếp
    FARM_MP_PAUSE_PCT: 0.2,
    FARM_MP_RESUME_PCT: 0.5,
    FARM_MP_CHECK_MS: 120000,
    // Ngưỡng HP (giống ngưỡng MP): HP% <= pause thì tạm dừng, HP% > resume thì chạy tiếp
    HP_GATE_PAUSE_PCT: 0.35, HP_GATE_RESUME_PCT: 0.4,
    // Đan hồi MP theo từng chế độ: dùng khi MP% <= low, dùng tới khi MP% >= high
    MP_PILL_DEFAULT_LOW: 0.2, MP_PILL_DEFAULT_HIGH: 0.6,
    // Boss: hết MP mà boss còn thì kiểm tra lại mỗi 9s, đủ MP cho 1 chiêu là đánh tiếp (không có ngưỡng %)
    BOSS_MP_CHECK_MS: 9000,
    // Bị "trọng thương": cứ 15s đọc HP, đạt >= 5% HP tối đa thì thử đánh lại (game còn từ chối thì lại chờ tiếp)
    INJURY_CHECK_MS: 5000,
    INJURY_RESUME_PCT: 0.05,
    // HP < 45% HP tối đa mà có chiêu type "heal" đủ MP thì đòn kế tiếp dùng chiêu đó
    // Đan hồi MP / HP: mỗi lần gọi /api/items/use dùng tối đa PILL_MAX_PER_USE viên, các lần cách nhau PILL_STEP_GAP_MS; nghỉ khi lỗi / hết đan
    // Hàng chờ lệnh gọi game: hai lệnh liên tiếp cách nhau tối thiểu REQ_GAP_MS (~1 lệnh/giây, game giới hạn 60 lệnh / phút); lệnh chờ quá REQ_AGING_MS được nâng một mức ưu tiên
    // REQ_WINDOW_MS chỉ dùng để ĐẾM số lệnh trong 60s gần nhất hiển thị trên bảng, không chặn lệnh
    HTTP_TIMEOUT_MS: 30000, // một lệnh gọi game quá chừng này không có phản hồi thì coi là lỗi (để cơ chế thử lại / watchdog xử lý, không đứng im)
    BOSS_LASTHIT_WAIT_MS: 1800000, // chờ last hit tối đa chừng này kể từ lúc tạm dừng; quá thì bỏ boss đó, nhả U Minh Cốc
    REQ_GAP_MS: 1050, REQ_WINDOW_MS: 60000, REQ_AGING_MS: 10000, REQ_PAUSE_MS: 10000, REQ_WARN_WAIT_MS: 2000, REQ_WARN_EVERY_MS: 60000,
    PILL_MAX_PER_USE: 30, PILL_MAX_STEPS: 100, PILL_STEP_GAP_MS: 1200, PILL_ERROR_BLOCK_MS: 60000, PILL_EMPTY_BLOCK_MS: 300000,
    HEAL_BELOW_PCT: 0.45,
    HEAL_DEFAULT_HIGH: 0.5,          // chiêu hồi máu: mặc định dùng khi HP < 45% (HEAL_BELOW_PCT) và dừng khi HP >= 50%; chỉnh được từng chế độ (5 – 95%, nấc 5%)
    SKILL_SCAN_MS: 20000, // quét bộ chiêu trong game mỗi 20s để phát hiện đổi ngoài tool
    SWAP_CALL_GAP_MS: 500, // đổi chiêu: nghỉ giữa các lần gọi tháo / gắn
    // Săn yêu: hết vé thì chờ, cứ tối đa 5 phút hỏi lại số vé (vé hồi 1 lượt / 60 phút, tối đa 10)
    HUNT_TICKET_MAX_WAIT_MS: 300000,
    // Đột phá: cứ BT_POLL_MS kiểm tra tu vi; chờ tối đa BT_IDLE_WAIT_MS để các trận đang đánh kết thúc trước khi đột phá
    BT_POLL_MS: 60000, BT_IDLE_WAIT_MS: 180000,
    BT_NEAR_RATIO: 0.99, BT_NEAR_POLL_MS: 5000, // tu vi đạt >= 99% mức cần: quét 5s một lần cho tới khi đủ
    BT_ERROR_RETRY_MS: 5000,         // đột phá lỗi: chờ cố định chừng này rồi thử lại
    BT_HOLD_MAX_MS: 30000,           // đột phá bắt các chế độ khác dừng giữa trận tối đa chừng này khi đang lỗi liên tục
    BT_SETTLE_MS: 1000,              // chờ đòn đang gửi dở của các chế độ khác xong rồi mới đột phá
    // Luyện đan: còn đan (> 0) thì cứ ALCHEMY_POLL_MS kiểm tra lại; hết đan (= 0) thì luyện tối đa ALCHEMY_MAX_TIMES lượt / lần
    ALCHEMY_POLL_MS: 300000, ALCHEMY_MAX_TIMES: 50, ALCHEMY_CRAFT_GAP_MS: 5000,
    // Luyện đan "đủ 50 lượt": nguyên liệu đủ ALCHEMY_MAX_TIMES lượt thì luyện ngay (bất kể còn đan), luyện liên tiếp cách nhau ALCHEMY_BULK_GAP_MS
    ALCHEMY_BULK_GAP_MS: 3000,
    // Yêu thú (mở Thú Đản + phóng sinh): Yêu Thú Các chứa tối đa BEAST_CAP con, mỗi lệnh mở tối đa BEAST_HATCH_MAX trứng; tự động kiểm tra lại mỗi BEAST_POLL_MS
    // Lỗi lặp: cùng một thông báo REPEAT_ERR_RESET lần liên tiếp → reset mềm (đọc lại trạng thái từ server); sau reset còn lặp thêm REPEAT_ERR_AFTER_RESET lần → chờ lâu hơn
    REPEAT_ERR_RESET: 3, REPEAT_ERR_AFTER_RESET: 2,
    REPEAT_START_WAIT_MS: 60000,     // vào trận (start / explore) lỗi lặp: reset mềm rồi chờ chừng này
    WATCHDOG_IDLE_MS: 180000,        // chế độ đang bật mà lỗi liên tục chừng này (không có lần thành công nào) → reset mềm; 0 = tắt
    // U Minh Cốc, chọn bước đi: điểm = quãng đường tới ô chưa mở + UM_OPEN_PENALTY × số ô chưa mở kế bên ô đó − UM_STRAIGHT_BONUS nếu đi tiếp thẳng (điểm thấp được chọn).
    // Ưu tiên ô có ít ô chưa mở kế bên (dọn gọn vùng đang mở trước, ít phải quay lại) + đi thẳng nhẹ. Mô phỏng: ít hơn ~9% số bước so với 'gần nhất'.
    // UM_MONSTER_COST: mỗi ô quái chưa đánh phải đi qua tốn thêm chừng này bước.
    UM_OPEN_PENALTY: 0.6, UM_STRAIGHT_BONUS: 0.3, UM_MONSTER_COST: 2,
    UM_NOGATE_WAIT_MS: 60000,        // không có cổng vào: thử lại sau chừng này cho tới hết phiên
    BT_RESTORE_TRIES: 5,             // đột phá xong: số lần thử đổi lại công pháp cũ (không được thì thử tiếp ở lần kiểm tra sau)
    SELL_MAX_PER_CALL: 999, SELL_CALL_GAP_MS: 1200, // bán đồ: mỗi lệnh tối đa chừng này, nghỉ giữa các lệnh
    CHEST_BATCH_MAX: 300,            // mở nhiều: mỗi lệnh dùng tối đa chừng này vật phẩm
    CHEST_CALL_GAP_MS: 1200,         // mở nhiều: nghỉ giữa các lượt
    BEAST_CAP: 20, BEAST_HATCH_MAX: 15, BEAST_CALL_GAP_MS: 1200, BEAST_POLL_MS: 3600000,
    // Linh điền: quét lại sau (thời gian còn lại ngắn nhất + EXTRA) để cả đợt cùng chín; không đủ linh thạch thì thử lại sau NOSTONE
    GARDEN_DEFAULT_SEED: 'Hạt Băng Tinh Thảo', GARDEN_EXTRA_WAIT_MS: 30000, GARDEN_NOSTONE_POLL_MS: 120000, GARDEN_CALL_GAP_MS: 500,
    XH_DEFAULT_DURATION: 5,          // xuất hồn: mức thời gian mặc định (phút); các mức khác lấy từ server (5 / 10 / 20 / 60)
    XH_MIN_BEFORE_HOUR_MIN: 5,       // xuất hồn: còn ít hơn max(5, mức đã chọn) phút tới đầu giờ thì không bắt đầu lượt mới
    XH_IDLE_MS: 15000,               // xuất hồn: đang chờ U Minh Cốc / tầm bảo xong thì kiểm tra lại mỗi chừng này
    XH_POLL_MS: 30000,               // xuất hồn: đang chạy thì đọc lại trạng thái mỗi chừng này (và ngay khi tới giờ xong)
    XH_CLAIM_MARGIN_MS: 1500,        // chờ thêm chừng này sau giờ kết thúc rồi mới nhận thưởng
    XH_HOUR_MARGIN_MS: 2000,         // nghỉ tới đầu giờ sau + chừng này
    XH_OPTIONS_TTL_MS: 600000,       // danh sách map xuất hồn (khóa / mở theo cảnh giới) làm mới mỗi 10 phút
    SKILL_QUEUE_POLL_MS: 1000,
    SKILL_RETRY_MS: 1500,            // game từ chối đổi chiêu vì còn trận: lần thử kế tiếp cách chừng này       // đổi chiêu bị hoãn vì đang trong trận: kiểm tra lại mỗi chừng này, hết trận thì đổi
    FARM_TICKET_WAIT_MARGIN_MS: 5000, // hết vé tầm bảo: chờ tới đầu giờ sau + chừng này
    SKILL_SLOTS: 3, // số ô chiêu thức tối đa (mặc định; server trả max_equipped thì dùng số đó)
    HP_PILL_TRIGGER_PCT: 0.05, HP_PILL_DEFAULT_TARGET: 0.2, // đan hồi HP: mặc định dùng khi HP < 5%, hồi lên 20% (x và y chỉnh bằng thanh trượt đôi, 5% – 95%, mỗi nấc 5%)
    ALCHEMY_DEFAULT_PILL: 'Huyết Sâm Đại Bổ Đan', // loại đan được chọn sẵn khi chưa từng chọn (so khớp theo tên thành phẩm)
    // U Minh Cốc: mỗi lần đi / ra đòn cách nhau >= UM_MIN_GAP_MS; gục (độc vụ...) tối đa UM_MAX_DEATHS lần / phiên thì bỏ phiên đó;
    LOGIN_MAX_FAILS: 3, LOGIN_RETRY_MS: 15000, LOGIN_HINT_MS: 15000, LOGIN_WAIT_MS: 90000, LOGIN_SENT_MS: 20000, // tự đăng nhập
    UM_BUSY_MAX: 30, UM_BUSY_WAIT_MS: 2000, // ô đang có trận: chờ UM_BUSY_WAIT_MS rồi thử lại, tối đa UM_BUSY_MAX lần liên tiếp
    UM_MIN_GAP_MS: 2000, UM_NOBATTLE_SCANS: 2, UM_MAX_DEATHS: 15,
    // Tông Chiến: không đánh người có lực chiến (power) cao hơn WAR_MAX_POWER; hồi máu khi HP < WAR_HEAL_BELOW_PCT; hỏi danh sách mục tiêu mỗi WAR_POLL_MS;
    // ngoài khung giờ sự kiện thì đọc lại trạng thái mỗi WAR_IDLE_POLL_MS; một trận quá WAR_MAX_ACTIONS đòn thì bỏ theo dõi (server tự xử lý)
    WAR_MAX_POWER: 12000, WAR_HEAL_BELOW_PCT: 0.35, WAR_MIN_GAP_MS: 1500, WAR_POLL_MS: 5000, WAR_IDLE_POLL_MS: 300000, WAR_MAX_ACTIONS: 60, WAR_SKIP_MS: 20000,
  };

  /* ===================== HẰNG SỐ DOMAIN ===================== */
  const SINH = { 'Mộc': 'Hỏa', 'Hỏa': 'Thổ', 'Thổ': 'Kim', 'Kim': 'Thủy', 'Thủy': 'Mộc' };
  const KHAC = { 'Kim': 'Mộc', 'Mộc': 'Thổ', 'Thổ': 'Thủy', 'Thủy': 'Hỏa', 'Hỏa': 'Kim' };
  const SIZE_ORDER = { small: 0, medium: 1, large: 2 };
  const SIZE_NAME = { small: 'Nhỏ', medium: 'Trung', large: 'Đại' };
  const REL_NAME = { khac: 'khắc', neutral: 'thường', sinh: 'sinh', heal: 'hồi máu' };
  const ZONES = [
    ['luyen_khi', 'Luyện Khí'], ['truc_co', 'Trúc Cơ'], ['kim_dan', 'Kim Đan'], ['nguyen_anh', 'Nguyên Anh'],
    ['hoa_than', 'Hóa Thần'], ['luyen_hu', 'Luyện Hư'], ['hop_the', 'Hợp Thể'], ['dai_thua', 'Đại Thừa'],
    ['do_kiep', 'Độ Kiếp'], ['tien_nhan', 'Tiên Nhân'],
  ];
  const DEFAULT_ZONE = 'nguyen_anh';

  /* =====================================================================
   *  1. DOMAIN (logic thuần)
   * ===================================================================== */

  class ElementRules {
    // khac: chiêu khắc boss (+15%) | sinh: chiêu sinh ra hệ của boss (-15%, vd skill Mộc đánh boss Hỏa)
    // neutral: mọi trường hợp còn lại (không liên quan, cùng hệ, boss sinh chiêu, boss khắc chiêu: game không phạt)
    static relation(skillEl, bossEl) {
      if (KHAC[skillEl] === bossEl) return 'khac';
      if (SINH[skillEl] === bossEl) return 'sinh';
      return 'neutral';
    }
  }
  ElementRules.RANK = { khac: 3, neutral: 2, sinh: 0 };

  class SkillSelector {
    // HP đang thấp (còn sống nhưng < HEAL_BELOW_PCT HP tối đa)? Cần biết cả hp lẫn hpMax.
    static isLowHp(hp, hpMax) {
      return typeof hp === 'number' && hpMax > 0 && hp > 0 && hp / hpMax < CFG.HEAL_BELOW_PCT;
    }

    // Chọn chiêu: ưu tiên chiêu khắc > chiêu không tương sinh. Không có chiêu phù hợp thì trả null (không dùng đánh thường).
    static pickAttack(skills, bossEl, mp) {
      let best = null;
      for (const s of skills || []) {
        if (s.type && s.type !== 'attack') continue;
        if (typeof mp === 'number' && s.mp_cost > mp) continue;
        const rel = ElementRules.relation(s.element, bossEl); // khắc > neutral > sinh: chiêu sinh (-15%) chỉ dùng khi không còn chiêu nào khác
        const score = ElementRules.RANK[rel] * 1000 + (s.damage_multiplier || 0);
        if (!best || score > best.score) best = { skill: s, rel, score };
      }
      return best ? { kind: 'skill', skill: best.skill, rel: best.rel } : null;
    }

    // Chiêu hồi máu (type 'heal') dùng ở đòn kế tiếp khi HP < 45%. Chọn chiêu hồi nhiều nhất trong số chiêu đủ MP.
    // want (tuỳ chọn) = engine đã tính sẵn có cần hồi máu không (HealSkillConfig.update); bỏ trống thì dùng ngưỡng cũ HP < 45%
    static pickHeal(skills, hp, hpMax, mp, want) {
      if (!(want === undefined ? SkillSelector.isLowHp(hp, hpMax) : want)) return null;
      let best = null;
      for (const s of skills || []) {
        if (s.type !== 'heal') continue;
        if (typeof mp === 'number' && s.mp_cost > mp) continue;
        if (!best || (s.damage_multiplier || 0) > (best.damage_multiplier || 0)) best = s;
      }
      return best ? { kind: 'skill', skill: best, rel: 'heal', heal: true } : null;
    }

    // Hồi máu có độ trễ: HP% < low thì bắt đầu hồi, đang hồi thì giữ tới khi HP% >= high. prev = đang hồi từ đòn trước
    static healWanted(hp, hpMax, prev, low, high) {
      if (!(typeof hp === 'number' && hpMax > 0 && hp > 0)) return false;
      const r = hp / hpMax;
      return r < low - 1e-9 || (!!prev && r < high - 1e-9);
    }

    static noHealReason(skills) {
      return (skills || []).some(s => s.type === 'heal') ? 'chiêu hồi máu không đủ MP' : 'chưa trang bị chiêu hồi máu';
    }

    static usableAttacks(skills, bossEl) {
      return (skills || []).filter(s => (!s.type || s.type === 'attack'));
    }

    // 'mp' (có chiêu hợp hệ nhưng thiếu MP, chờ MP hồi là đánh tiếp được) hay 'element' (chỉ còn chiêu tương sinh / chưa trang bị)
    static noSkillCause(skills, bossEl, mp) {
      return SkillSelector.usableAttacks(skills, bossEl).length && typeof mp === 'number' ? 'mp' : 'element';
    }

    static noSkillReason(skills, bossEl, mp) {
      if (SkillSelector.noSkillCause(skills, bossEl, mp) === 'mp') {
        const usable = SkillSelector.usableAttacks(skills, bossEl);
        return `hết MP (còn ${mp}, chiêu rẻ nhất cần ${Math.min(...usable.map(s => s.mp_cost))})`;
      }
      return 'chưa trang bị chiêu tấn công nào';
    }
  }

  class CombatFormatter {
    // Số phần trăm kiểu 60,3% / 63,59% (tối đa 2 chữ số thập phân, bỏ số 0 thừa, dấu phẩy)
    static fmtPct(a, b) {
      if (typeof a !== 'number' || !(b > 0)) return '?%';
      return String(Math.round(a / b * 10000) / 100).replace('.', ',') + '%';
    }

    // Tách sát thương từ nhật ký trận: dòng có `dùng "<tên chiêu>"` là đòn của mình, các dòng "gây N sát thương" còn lại là quái đánh mình
    static sumHits(lines, skillName) {
      let dealt = 0, taken = 0;
      for (const raw of lines || []) {
        const line = typeof raw === 'string' ? raw : (raw && (raw.text || raw.message)) || '';
        const m = /gây ([\d.,]+) sát thương/.exec(line);
        if (!m) continue;
        const n = Number(m[1].replace(/[.,]/g, '')) || 0;
        if (skillName && line.includes(`dùng "${skillName}"`)) dealt += n; else taken += n;
      }
      return { dealt, taken };
    }

    // (khắc) Kim Quang Trảm: -2152 (3269/5421 - 60,3%) | quái đánh: -120 (còn 85,5% HP) | MP: 597 (20,4%)
    static fightLine(o) {
      const fmt = CombatFormatter.fmtPct;
      const head = o.heal
        ? `(${REL_NAME.heal}) ${o.name}: HP ${o.hp}/${o.hpMax}`
        : `${o.rel === 'sinh' ? '⚠ ' : ''}(${REL_NAME[o.rel] || o.rel}) ${o.name}: -${o.dealt ?? '?'}`; // ⚠ = chiêu tương sinh, dùng vì không còn chiêu khác
      const foe = typeof o.foeHp !== 'number' ? ''
        : o.foeMax > 0 ? ` (${o.foeHp}/${o.foeMax} - ${fmt(o.foeHp, o.foeMax)})` : ` (còn ${o.foeHp} HP)`;
      const mine = o.hpMax > 0 ? ` (còn ${fmt(o.hp, o.hpMax)} HP)` : (typeof o.hp === 'number' ? ` (HP ${o.hp})` : '');
      const mp = typeof o.mp !== 'number' ? 'MP: ?' : `MP: ${o.mp}${o.mpMax > 0 ? ` (${fmt(o.mp, o.mpMax)})` : ''}`;
      return `${head}${foe} | quái đánh: -${o.taken ?? 0}${mine} | ${mp}`;
    }
  }

  class BossCatalog {
    // Chế độ nâng cao theo từng cỡ boss: 'full' đánh tới cùng (mặc định) | 'min70' chỉ đánh khi boss còn ≥ 70% HP (xuống dưới 70% là dừng, kể cả đang đánh) |
    //  'dmg50' / 'dmg25' sát thương của bạn đạt 50% / 25% HP tối đa thì tạm dừng, chờ boss còn ≤ 2.5% HP rồi đánh tiếp (giành last hit).
    static get MODES() { return ['full', 'min70', 'dmg50', 'dmg25']; }
    static get DMG() { return { dmg50: 0.5, dmg25: 0.25 }; }
    static get ENTRY_MIN() { return 0.7; }
    static get LAST_HIT() { return 0.025; }
    static pct(b) { return b.hp_max > 0 ? b.hp / b.hp_max : 1; }
    static active(b, nowMs) { return b.status === 'active' && b.hp > 0 && (!b.expires_at || Date.parse(b.expires_at) > nowMs); }
    // Boss có được đánh ngay không theo chế độ của cỡ nó. paused = id boss đang tạm dừng chờ last hit.
    static eligible(b, modes, paused) {
      const m = (modes && modes[b.size]) || 'full';
      if (m === 'min70') return BossCatalog.pct(b) >= BossCatalog.ENTRY_MIN;
      if (BossCatalog.DMG[m] && paused && paused.has(b.id)) return BossCatalog.pct(b) <= BossCatalog.LAST_HIT;
      return true;
    }
    // sát thương của bạn đã tới ngưỡng tạm dừng của chế độ dmg50 / dmg25 và boss chưa xuống tới mốc last hit
    static shouldPause(mode, sp, myDamage) {
      const f = BossCatalog.DMG[mode];
      return !!f && sp.hp_max > 0 && Number(myDamage) >= f * sp.hp_max && BossCatalog.pct(sp) > BossCatalog.LAST_HIT;
    }
    // Chọn boss: chỉ boss đang active, chưa hết hạn, loại được bật, hợp chế độ nâng cao (opt = { modes, paused }); nhỏ -> trung -> đại
    static pick(list, enabled, nowMs, opt = {}) {
      return (list || [])
        .filter(b => BossCatalog.active(b, nowMs) && enabled[b.size] && BossCatalog.eligible(b, opt.modes, opt.paused))
        .sort((a, b) => (!!(opt.paused && opt.paused.has(b.id)) - !!(opt.paused && opt.paused.has(a.id))) || (SIZE_ORDER[a.size] - SIZE_ORDER[b.size]) || (a.id - b.id))[0] || null; // boss đang chờ last hit mà đã tới mốc thì đánh trước
    }
  }

  class MonsterCatalog {
    // Sắp xếp theo required_realm tăng dần; cùng required_realm thì theo id tăng dần
    static sort(list) {
      return (list || []).slice().sort((a, b) => (a.required_realm - b.required_realm) || (a.id - b.id));
    }
    // Đánh được khi cảnh giới nhân vật (realm_id) >= required_realm. Chưa biết cảnh giới thì coi là đánh được.
    static canFight(m, realm) {
      return typeof realm !== 'number' || m.required_realm <= realm;
    }
    // Mặc định: required_realm lớn nhất đánh được, trong đó lấy id nhỏ nhất. Chưa biết cảnh giới -> null.
    static pickDefault(list, realm) {
      if (typeof realm !== 'number') return null;
      let best = null;
      for (const m of MonsterCatalog.sort(list)) {
        if (!MonsterCatalog.canFight(m, realm)) continue;
        if (!best || m.required_realm > best.required_realm) best = m; // cùng realm: giữ cái id nhỏ đã gặp trước
      }
      return best;
    }
    static label(m, realm) {
      return `[${m.required_realm}] #${m.id} ${m.name} (${m.element})${MonsterCatalog.canFight(m, realm) ? '' : ' 🔒'}`;
    }
  }

  class PillCatalog {
    // Giá trị hồi của một vật phẩm trong túi theo loại effect ('heal_hp' | 'heal_mp'). effects có thể là mảng hoặc chuỗi JSON. 0 nếu không phải.
    static value(item, type) {
      if (!item || !item.is_consumable) return 0;
      let fx = item.effects;
      if (typeof fx === 'string') { try { fx = JSON.parse(fx); } catch (_) { fx = []; } }
      if (!Array.isArray(fx)) return 0;
      return fx.filter(e => e && e.type === type).reduce((a, e) => a + (Number(e.value) || 0), 0);
    }
    // Đan chỉ có đúng một công dụng `type` (không kèm công dụng khác, vd. Huyết Sâm Đại Bổ Đan hồi cả HP lẫn MP thì không thuần)
    static isPure(item, type) {
      let fx = item && item.effects;
      if (typeof fx === 'string') { try { fx = JSON.parse(fx); } catch (_) { fx = []; } }
      if (!Array.isArray(fx)) return false;
      const real = fx.filter(e => e && e.type);
      return real.length > 0 && real.every(e => e.type === type);
    }
    static mpValue(item) { return PillCatalog.value(item, 'heal_mp'); }
    static hpValue(item) { return PillCatalog.value(item, 'heal_hp'); }
    // Danh sách đan theo loại effect, gộp các ô cùng item_id, còn số lượng, xếp từ hồi ÍT nhất đến NHIỀU nhất.
    // Mỗi phần tử: { itemId, name, value, qty, stacks: [{ id, qty }] }
    static list(inventory, type) {
      const m = new Map();
      for (const it of inventory || []) {
        const v = PillCatalog.value(it, type), q = Number(it && it.quantity) || 0;
        if (!(v > 0) || q <= 0) continue;
        const key = it.item_id != null ? it.item_id : it.name;
        if (!m.has(key)) m.set(key, { itemId: key, name: it.name, value: v, qty: 0, stacks: [], pure: PillCatalog.isPure(it, type) });
        const e = m.get(key); e.qty += q; e.stacks.push({ id: it.id, qty: q });
      }
      return [...m.values()].sort((a, b) => a.value - b.value || String(a.name).localeCompare(String(b.name)));
    }
    // Chọn đan để dùng: có itemId (loại đã chọn trong "Đan") thì chỉ dùng loại đó; chưa chọn thì hồi nhiều nhất.
    // Trả về { id, name, value, qty } hoặc null (hết đan / loại đã chọn hết).
    static pick(inventory, itemId = null, type = 'heal_mp') {
      const list = PillCatalog.list(inventory, type);
      if (itemId != null) {
        const e = list.find(x => x.itemId === itemId);
        return e ? { id: e.stacks[0].id, name: e.name, value: e.value, qty: e.stacks[0].qty } : null;
      }
      const e = list[list.length - 1];
      return e ? { id: e.stacks[0].id, name: e.name, value: e.value, qty: e.stacks[0].qty } : null;
    }
  }

  class AlchemyCatalog {
    // Đan phương đã học và không bị khóa (cấp luyện đan / cảnh giới). Dùng cho droplist.
    static craftable(recipes) {
      return (recipes || []).filter(r => r && r.learned && !r.levelLocked && !r.realmLocked);
    }
    // Tổng số viên đan (thành phẩm của đan phương) đang có trong túi. Ưu tiên khớp item_id, dự phòng khớp theo tên.
    static owned(inventory, recipe) {
      if (!recipe) return 0;
      let n = 0;
      for (const it of inventory || []) {
        if (!it) continue;
        const same = it.item_id != null && recipe.result_item_id != null ? it.item_id === recipe.result_item_id : it.name === recipe.result_name;
        if (same) n += Number(it.quantity) || 0;
      }
      return n;
    }
    // Số lượt luyện cho 1 lần: tối đa `cap`, và không vượt số lượt nguyên liệu cho phép (maxTimes). 0 = không luyện được.
    static batchTimes(recipe, cap) {
      const mt = recipe && typeof recipe.maxTimes === 'number' ? recipe.maxTimes : 0;
      return Math.max(0, Math.min(cap, mt));
    }
    static label(r) { return `${r.result_name || r.name}${typeof r.maxTimes === 'number' ? ` (luyện được ${r.maxTimes} lượt)` : ''}`; }
  }

  class SkillCatalog {
    static KIND = { attack: 'Công kích', heal: 'Hồi máu', buff: 'Tăng công/thủ', debuff: 'Giảm công/thủ địch', reflect: 'Phản sát thương', invincible: 'Miễn sát thương', reduce: 'Giảm sát thương nhận' };
    // Phản hồi của game (từ 11/2026): { max_equipped, skills: [{ skill_id, is_equipped, name, element, mp_cost, accuracy, effects: [{ type, mult|pct|pierce|rounds }] }] }
    // → { slots, skills }. Mỗi chiêu có thêm id = skill_id (mọi nơi trong tool dùng .id), type_code = 'skill' và các trường cũ
    // skill_kind / skill_element / skill_mp_cost / skill_damage_multiplier / skill_accuracy / skill_pierce (suy ra từ effects) để phần còn lại không phải đổi.
    // Vẫn đọc được dạng cũ (item_id + skill_kind...).
    static EFFECT_KIND = ['damage:attack', 'heal:heal', 'buff:buff', 'debuff:debuff', 'invincible:invincible', 'dmg_reduction:reduce', 'reflect:reflect'];
    static kindOf(effects) {
      const types = (Array.isArray(effects) ? effects : []).map(e => e && e.type);
      for (const p of SkillCatalog.EFFECT_KIND) { const [t, k] = p.split(':'); if (types.includes(t)) return k; }
      return null;
    }
    static normalizeOne(x) {
      const id = x.skill_id != null ? x.skill_id : x.item_id;
      const fx = Array.isArray(x.effects) ? x.effects : [];
      const kind = x.skill_kind || SkillCatalog.kindOf(fx);
      const main = fx.find(e => e && (e.type === 'damage' || e.type === 'heal')) || {};
      const out = { ...x, id, type_code: 'skill', is_equipped: x.is_equipped ? 1 : 0 };
      if (kind != null) out.skill_kind = kind;
      if (out.skill_element == null && x.element != null) out.skill_element = x.element;
      if (out.skill_mp_cost == null && x.mp_cost != null) out.skill_mp_cost = Number(x.mp_cost);
      if (out.skill_accuracy == null && x.accuracy != null) out.skill_accuracy = Number(x.accuracy);
      if (out.skill_damage_multiplier == null && (main.mult != null || main.pct != null)) out.skill_damage_multiplier = String(main.mult != null ? main.mult : main.pct);
      if (out.skill_pierce == null) { const p = fx.find(e => e && e.pierce != null); if (p) out.skill_pierce = Number(p.pierce); }
      return out;
    }
    static normalize(data) {
      const list = data && Array.isArray(data.skills) ? data.skills : Array.isArray(data) ? data : [];
      const slots = data && Number(data.max_equipped) > 0 ? Number(data.max_equipped) : CFG.SKILL_SLOTS;
      return { slots, skills: list.filter(x => x && (x.skill_id != null || x.item_id != null)).map(SkillCatalog.normalizeOne) };
    }
    static isSkill(it) { return !!(it && (it.type_code === 'skill' || it.skill_kind)); }
    static all(inv) { return (inv || []).filter(SkillCatalog.isSkill); }
    static equipped(inv) { return SkillCatalog.all(inv).filter(x => x.is_equipped); }
    // So sánh theo phí MP tăng dần; thiếu MP -> cuối; bằng nhau: cảnh giới yêu cầu thấp trước, rồi tên
    static byMp(a, b) {
      const m = x => (typeof x.skill_mp_cost === 'number' ? x.skill_mp_cost : Infinity);
      const ma = m(a), mb = m(b);
      return (ma === mb ? 0 : ma < mb ? -1 : 1) || (a.required_realm || 0) - (b.required_realm || 0) || String(a.name).localeCompare(String(b.name));
    }
    // Chiêu chưa trang bị, xếp theo phí MP tăng dần
    static available(inv) {
      return SkillCatalog.all(inv).filter(x => !x.is_equipped).sort(SkillCatalog.byMp);
    }
    static kindName(k) { return SkillCatalog.KIND[k] || k || '?'; }
    // Kế hoạch đổi chiêu trước boss để khắc hệ `el`. Trả { actions: [{ op: 'unequip' | 'equip', item }], reason, add: [..] }.
    //  ok     = đang mang sẵn ít nhất 1 chiêu công kích khắc `el` (hoặc không biết hệ) → không đổi, không tìm chiêu dự bị.
    //  nopool = đang mang không có chiêu khắc nhưng chưa chọn chiêu dự bị ("Chiêu dùng để thay" trống) → không tìm, giữ nguyên.
    //  none   = chiêu dự bị không có chiêu công kích khắc nào dùng được (đủ cảnh giới, chưa gắn) → giữ nguyên.
    //  locked = có chiêu khắc dự bị nhưng ô đầy và không tháo được chiêu nào (khóa 🔒 / chỉ còn 1 chiêu hồi máu) → giữ nguyên.
    //  swap   = đổi tối thiểu: còn ô trống thì chỉ gắn chiêu khắc mạnh nhất trong dự bị; hết ô thì tháo 1 chiêu yếu nhất rồi gắn.
    //  Chiêu bị tháo (ưu tiên): công kích không khắc (hệ 'sinh' trước, rồi sát thương thấp nhất) > chiêu khác không phải hồi máu > hồi máu (chỉ khi đang mang ≥ 2 chiêu hồi máu).
    //  opts.pool  = Set id (inventory id) chiêu dự bị
    //  opts.slots = số ô chiêu tối đa (mặc định CFG.SKILL_SLOTS)
    //  opts.locked = Set id các chiêu bị khóa: không bao giờ tháo
    static plan(inv, el, realm, opts = {}) {
      const all = SkillCatalog.all(inv).filter(x => x.is_equippable !== 0 && x.is_equippable !== false);
      const isAtk = x => x.skill_kind === 'attack';
      const rel = x => ElementRules.relation(x.skill_element, el);
      const mult = x => Number(x.skill_damage_multiplier) || 0;
      const byDmg = (a, b) => mult(b) - mult(a) || (a.skill_mp_cost || 0) - (b.skill_mp_cost || 0);
      const eq = all.filter(x => x.is_equipped);
      if (!el || eq.some(x => isAtk(x) && rel(x) === 'khac')) return { actions: [], reason: 'ok', add: [] };
      const pool = opts.pool && opts.pool.size ? opts.pool : null;
      if (!pool) return { actions: [], reason: 'nopool', add: [] };
      const best = all.filter(x => !x.is_equipped && pool.has(x.id) && (realm == null || (x.required_realm || 0) <= realm) && isAtk(x) && rel(x) === 'khac').sort(byDmg)[0];
      if (!best) return { actions: [], reason: 'none', add: [] };
      const slots = opts.slots > 0 ? opts.slots : CFG.SKILL_SLOTS;
      const actions = [];
      if (eq.length >= slots) {
        const free = eq.filter(x => !(opts.locked && opts.locked.has(x.id)));
        const nonKhacAtk = free.filter(x => isAtk(x) && rel(x) !== 'khac').sort((a, b) => ((rel(b) === 'sinh') - (rel(a) === 'sinh')) || byDmg(b, a));
        const other = free.filter(x => !isAtk(x) && x.skill_kind !== 'heal').sort((a, b) => byDmg(b, a));
        const heals = eq.filter(x => x.skill_kind === 'heal');
        const healFree = heals.length >= 2 ? free.filter(x => x.skill_kind === 'heal').sort((a, b) => byDmg(b, a)) : [];
        const victim = nonKhacAtk[0] || other[0] || healFree[0];
        if (!victim) return { actions: [], reason: 'locked', add: [] };
        actions.push({ op: 'unequip', item: victim });
      }
      actions.push({ op: 'equip', item: best });
      return { actions, reason: 'swap', add: [best] };
    }
    // Kế hoạch đổi chiêu trước Tông Chiến (server chụp bộ chiêu lúc vào lãnh địa, sau đó không đổi được): 1 chiêu hồi máu mạnh nhất + các chiêu công kích
    // mạnh nhất (hệ không quan trọng vì đối thủ không có hệ), đủ số ô. Chiêu khóa 🔒 đang mang thì giữ. Trả { actions: [{ op, item }], reason: 'ok' | 'swap' }.
    static planWar(inv, realm, opts = {}) {
      const mult = x => Number(x.skill_damage_multiplier) || 0;
      const byDmg = (a, b) => mult(b) - mult(a) || (a.skill_mp_cost || 0) - (b.skill_mp_cost || 0);
      const usable = SkillCatalog.all(inv).filter(x => x.is_equippable !== 0 && x.is_equippable !== false && (x.is_equipped || realm == null || (x.required_realm || 0) <= realm));
      const slots = opts.slots > 0 ? opts.slots : CFG.SKILL_SLOTS, locked = opts.locked || new Set();
      const want = usable.filter(x => x.is_equipped && locked.has(x.id));
      const heal = usable.filter(x => x.skill_kind === 'heal').sort(byDmg)[0];
      if (heal && want.length < slots && !want.some(x => x.skill_kind === 'heal')) want.push(heal);
      for (const a of usable.filter(x => x.skill_kind === 'attack').sort(byDmg)) if (want.length < slots && !want.includes(a)) want.push(a);
      const ids = new Set(want.map(x => x.id));
      const actions = [
        ...usable.filter(x => x.is_equipped && !ids.has(x.id)).map(item => ({ op: 'unequip', item })),
        ...want.filter(x => !x.is_equipped).map(item => ({ op: 'equip', item })),
      ];
      return { actions, reason: actions.length ? 'swap' : 'ok' };
    }
    // Xoay ô dự bị: chiêu `added[i]` vừa được gắn thay cho chiêu `removed[i]` (ghép theo thứ tự, không phân biệt loại chiêu).
    // Nếu chiêu vừa gắn đang nằm trong ô dự bị thì ô đó đổi thành chiêu vừa bị tháo (giữ nguyên vị trí). Không đổi khi chiêu nào trong cặp bị khóa 🔒,
    // chiêu bị tháo không phải công kích / hồi máu (droplist không có), hoặc chiêu bị tháo đã nằm trong ô dự bị khác.
    // Trả { pool: [id...], changes: [{ from, to }] }; pool rỗng (= dùng mọi chiêu) thì không đổi gì.
    static rotatePool(added, removed, pool, locked) {
      const out = [...(pool || [])], changes = [], lk = locked || new Set();
      if (!out.length) return { pool: out, changes };
      for (let i = 0; i < Math.min(added.length, removed.length); i++) {
        const a = added[i], b = removed[i];
        const at = out.indexOf(a.id);
        if (at < 0 || lk.has(a.id) || lk.has(b.id) || out.includes(b.id)) continue;
        if (!(b.skill_kind === 'attack' || b.skill_kind === 'heal') || b.is_equippable === 0 || b.is_equippable === false) continue;
        out[at] = b.id; changes.push({ from: a, to: b });
      }
      return { pool: out, changes };
    }
    // Như trên nhưng tự tìm chiêu thêm / bớt bằng cách so 2 bộ chiêu đang trang bị (dùng khi bạn đổi chiêu ngoài tool)
    static rotateByDiff(prevEq, newEq, pool, locked) {
      const pid = new Set((prevEq || []).map(x => x.id)), nid = new Set((newEq || []).map(x => x.id));
      return SkillCatalog.rotatePool((newEq || []).filter(x => !pid.has(x.id)), (prevEq || []).filter(x => !nid.has(x.id)), pool, locked);
    }
    // "Kim Quang Trảm (Kim · Công kích · 15 MP · ×1.49)"
    static label(x) {
      return `${x.name} (${x.skill_element || '?'} · ${SkillCatalog.kindName(x.skill_kind)} · ${x.skill_mp_cost ?? '?'} MP · ×${Number(x.skill_damage_multiplier || 0)})`;
    }
  }

  class GardenCatalog {
    // Hạt giống trồng được (chưa bị khóa cảnh giới), xếp theo giá tăng dần
    static seeds(state) {
      return ((state && state.shop && state.shop.seeds) || []).filter(x => x && !x.locked).sort((a, b) => a.price - b.price || a.id - b.id);
    }
    static label(x) { const m = Math.round(x.growSeconds / 60); return `${x.name} (${x.price.toLocaleString()} linh thạch, ${m >= 120 ? Math.round(m / 6) / 10 + ' giờ' : m + ' phút'})`; }
    static plots(state) { return (state && state.plots) || []; }
    static ready(plots) { return plots.filter(p => p.status === 'ready'); }
    static empty(plots) { return plots.filter(p => p.status === 'empty'); }
    static growing(plots) { return plots.filter(p => p.status === 'growing'); }
    // Giây còn lại ngắn nhất trong các ô đang lớn (null nếu không có ô nào đang lớn)
    static minRemaining(plots) {
      const g = GardenCatalog.growing(plots);
      return g.length ? Math.max(0, Math.min(...g.map(p => Number(p.secondsRemaining) || 0))) : null;
    }
  }

  /**
   * Bản đồ U Minh Cốc (lưới size×size, ô đánh số i = hàng*size + cột). Logic thuần, không side-effect.
   * Mỗi ô: { i, r } với r=0 là ô CHƯA MỞ (không biết gì); r=1 là ô đã mở, kèm t = 'empty' | 'monster' | 'poison' | 'reward' | 'rock',
   * st = 'fresh' | 'cleared' | 'looted'. Đi vào ô chưa mở sẽ mở ô đó (có thể là độc vụ: HP về 0 và bị đẩy ra).
   */
  class UMinhPlanner {
    static coord(idx, size) { return { row: Math.floor(idx / size), col: idx % size }; }
    static label(idx, size) { const { row, col } = UMinhPlanner.coord(idx, size); return `cột ${col + 1}, hàng ${row + 1}`; }
    static index(cells) { const m = new Map(); for (const c of cells || []) if (c && typeof c.i === 'number') m.set(c.i, c); return m; }
    // Các ô kế bên (không vượt biên) kèm hướng đi
    static neighbors(idx, size) {
      const { row, col } = UMinhPlanner.coord(idx, size), out = [];
      if (row > 0) out.push({ dir: 'up', idx: idx - size });
      if (row < size - 1) out.push({ dir: 'down', idx: idx + size });
      if (col > 0) out.push({ dir: 'left', idx: idx - 1 });
      if (col < size - 1) out.push({ dir: 'right', idx: idx + 1 });
      return out;
    }
    static isKnown(cell) { return !!(cell && cell.r); }
    // Ô đã biết mà đi được: không phải núi đá (không qua được) và không phải độc vụ (chết). Quái và rương thì đi vào được.
    static passable(cell) { return UMinhPlanner.isKnown(cell) && cell.t !== 'rock' && cell.t !== 'poison'; }
    // Chi phí đi VÀO một ô đã mở: 1 bước, ô quái chưa đánh tốn thêm UM_MONSTER_COST (vào là phải đánh)
    static stepCost(cell) { return 1 + (cell.t === 'monster' && cell.st === 'fresh' ? CFG.UM_MONSTER_COST : 0); }

    // Dijkstra từ `from` qua các ô đã mở đi được (rương / Thú Đản đã xác định thì đã nhặt rồi nên chỉ là ô thường).
    // Đích = ô chưa mở kế bên vùng đã biết (đi vào sẽ mở khóa, không đi tiếp qua nó). `skip` = ô tạm bỏ qua ở lần chọn này (vd. có người chơi khác đang đứng).
    static search(cells, size, from, skip = null) {
      const byIdx = UMinhPlanner.index(cells);
      const dist = new Map([[from, 0]]), parent = new Map([[from, null]]), alts = new Map(), done = new Set(), targets = [], seenUnknown = new Set();
      const open = [from];
      const addAlt = (n, p) => { const a = alts.get(n); if (a) { if (!a.includes(p)) a.push(p); } else alts.set(n, [p]); }; // mọi ô cha cùng cho đường ngắn nhất (để biết các hướng đi đầu tiên đều tối ưu)
      while (open.length) {
        let bi = 0; for (let k = 1; k < open.length; k++) if (dist.get(open[k]) < dist.get(open[bi])) bi = k;
        const cur = open.splice(bi, 1)[0]; if (done.has(cur)) continue; done.add(cur);
        const d = dist.get(cur);
        for (const n of UMinhPlanner.neighbors(cur, size)) {
          const cell = byIdx.get(n.idx);
          if (!cell || (skip && skip.has(n.idx))) continue;
          if (!UMinhPlanner.isKnown(cell)) {
            if (!seenUnknown.has(n.idx) || d + 1 < dist.get(n.idx)) {
              if (!seenUnknown.has(n.idx)) { seenUnknown.add(n.idx); targets.push({ idx: n.idx, kind: 'unknown' }); }
              dist.set(n.idx, d + 1); parent.set(n.idx, cur); alts.set(n.idx, [cur]);
            } else if (d + 1 === dist.get(n.idx)) addAlt(n.idx, cur);
            continue;
          }
          if (!UMinhPlanner.passable(cell) || done.has(n.idx)) continue;
          const nd = d + UMinhPlanner.stepCost(cell);
          if (!dist.has(n.idx) || nd < dist.get(n.idx)) { dist.set(n.idx, nd); parent.set(n.idx, cur); alts.set(n.idx, [cur]); open.push(n.idx); }
          else if (nd === dist.get(n.idx)) addAlt(n.idx, cur);
        }
      }
      for (const t of targets) {
        t.dist = dist.get(t.idx);
        t.open = UMinhPlanner.neighbors(t.idx, size).filter(m => byIdx.get(m.idx) && !UMinhPlanner.isKnown(byIdx.get(m.idx))).length;
      }
      return { parent, alts, dist, targets };
    }

    // Bước kế tiếp (RAFE rút gọn: ô chưa mở kế bên vùng đã biết = "frontier", chấm điểm, đi theo đường ngắn nhất tới frontier điểm thấp nhất).
    // Điểm = quãng đường + UM_OPEN_PENALTY × số ô chưa mở kế bên frontier − UM_STRAIGHT_BONUS nếu bước đầu đi tiếp thẳng theo `lastDir`.
    // Trả về { dir, next, target, dist, kind } hoặc null nếu không còn đích nào đi tới được.
    static nextStep(cells, size, from, lastDir = null, skip = null) {
      const { alts, targets } = UMinhPlanner.search(cells, size, from, skip);
      if (!targets.length) return null;
      const nbs = UMinhPlanner.neighbors(from, size), memo = new Map();
      const firsts = node => { // các ô đầu tiên (kế bên `from`) nằm trên MỌI đường ngắn nhất tới node
        if (memo.has(node)) return memo.get(node);
        const set = new Set();
        for (const p of alts.get(node) || []) { if (p === from) set.add(node); else for (const f of firsts(p)) set.add(f); }
        memo.set(node, set); return set;
      };
      for (const t of targets) {
        const fs = firsts(t.idx), dirs = nbs.filter(n => fs.has(n.idx));
        t.straight = !!(lastDir && dirs.some(n => n.dir === lastDir));
        const pick = (t.straight ? dirs.find(n => n.dir === lastDir) : dirs[0]) || null;
        t.dir = pick ? pick.dir : null; t.next = pick ? pick.idx : null;
      }
      const score = t => t.dist + CFG.UM_OPEN_PENALTY * t.open - (t.straight ? CFG.UM_STRAIGHT_BONUS : 0);
      const cand = targets.filter(t => t.dir);
      if (!cand.length) return null;
      cand.sort((x, y) => (score(x) - score(y)) || (x.idx - y.idx));
      const best = cand[0];
      return { dir: best.dir, next: best.next, target: best.idx, dist: best.dist, kind: best.kind };
    }
    // Số ô CHƯA MỞ trong bán kính `radius` (kiểu bàn cờ: 1 = 8 ô xung quanh, 3 = vùng 7×7) quanh ô idx, không tính chính nó
    static unknownAround(cells, size, idx, radius) {
      const byIdx = UMinhPlanner.index(cells), { row, col } = UMinhPlanner.coord(idx, size);
      let n = 0;
      for (let r = Math.max(0, row - radius); r <= Math.min(size - 1, row + radius); r++)
        for (let c = Math.max(0, col - radius); c <= Math.min(size - 1, col + radius); c++) {
          const i = r * size + c; if (i === idx) continue;
          const cell = byIdx.get(i); if (cell && !UMinhPlanner.isKnown(cell)) n++;
        }
      return n;
    }

    // Chọn cổng vào. preferred = key của cổng ('top' | 'bottom' | 'left' | 'right') hoặc 'auto'.
    // Tự chọn: bỏ cổng bị chặn (không có đường khám phá nào); nếu còn cổng khác thì bỏ cổng `avoidKey` (cổng vừa gục);
    // rồi chọn cổng có NHIỀU Ô CHƯA MỞ NHẤT trong 8 ô xung quanh; ngang nhau thì xét vùng bán kính 3 ô; vẫn ngang thì ngẫu nhiên.
    static chooseGate(cells, size, spawns, preferred, rand = Math.random, avoidKey = null) {
      const list = spawns || [];
      const pick = list.find(s => s.key === preferred);
      if (pick) return pick;
      const scored = list.map(s => { const tg = UMinhPlanner.search(cells, size, s.idx).targets; return { s, n: tg.length, near: tg.length ? Math.min(...tg.map(t => t.dist)) : Infinity, a1: UMinhPlanner.unknownAround(cells, size, s.idx, 1), a3: UMinhPlanner.unknownAround(cells, size, s.idx, 3) }; });
      const open = scored.filter(x => x.n > 0);
      let pool = open.length ? open : scored;
      if (!pool.length) return null;
      if (avoidKey && pool.some(x => x.s.key !== avoidKey)) pool = pool.filter(x => x.s.key !== avoidKey);
      { const near = Math.min(...pool.map(x => x.near)); pool = pool.filter(x => x.near === near); } // cổng có ô chưa mở gần nhất (đỡ phải đi bộ lại sau khi gục)
      for (const f of ['a1', 'a3']) { const top = Math.max(...pool.map(x => x[f])); pool = pool.filter(x => x[f] === top); }
      return pool[Math.floor(rand() * pool.length) % pool.length].s;
    }
  }
  UMinhPlanner.DIR_NAME = { up: 'lên', down: 'xuống', left: 'sang trái', right: 'sang phải' };

  // Ngủ tổng cộng ms nhưng chia nhỏ <= 1s để bấm Tắt là dừng ngay
  async function sleepSlices(sleep, ms, alive) {
    for (let w = 0; w < ms && alive(); w += 1000) await sleep(Math.min(1000, ms - w));
  }
  // Lỗi game trả khi nhân vật đang trọng thương ("...đang trọng thương, cần dưỡng thương trước khi tiếp tục giao chiến.")
  const isInjuredError = e => /trọng thương|dưỡng thương/i.test((e && e.message) || '');

  /* =====================================================================
   *  2. HẠ TẦNG
   * ===================================================================== */

  const fmtSec = sec => { const t = Math.max(0, Math.round(Number(sec) || 0)), m = Math.floor(t / 60), r = t % 60; return m ? `${m} phút${r ? ` ${r} giây` : ''}` : `${r} giây`; };

  class EventEmitter {
    constructor() { this._handlers = new Map(); }
    on(evt, fn) {
      let set = this._handlers.get(evt);
      if (!set) this._handlers.set(evt, set = new Set());
      set.add(fn);
      return () => this.off(evt, fn); // trả về hàm huỷ đăng ký
    }
    once(evt, fn) { const off = this.on(evt, (...a) => { off(); fn(...a); }); return off; }
    off(evt, fn) { const s = this._handlers.get(evt); if (s) s.delete(fn); }
    emit(evt, ...args) {
      const set = this._handlers.get(evt);
      if (!set || !set.size) return false;
      for (const fn of [...set]) {
        try { fn(...args); } catch (e) { console.error(`[Auto Boss] lỗi listener "${evt}":`, e); }
      }
      return true;
    }
  }

  /**
   * Máy trạng thái hữu hạn dạng "handler trả về trạng thái kế tiếp".
   *  - handlers: { TÊN: async ctx => tênTrạngTháiKếTiếp | null }   (null = kết thúc)
   *  - transitions: { TÊN: [các trạng thái được phép chuyển tới] } (chuyển trái phép sẽ ném lỗi)
   * Phát sự kiện: 'enter'(state, prev), 'exit'(state), 'end'(lastState).
   */
  class StateMachine extends EventEmitter {
    constructor(name, handlers, transitions) {
      super();
      this.name = name; this.handlers = handlers; this.transitions = transitions || {};
      this.state = null;
    }
    canGo(from, to) { return !from || (this.transitions[from] || []).includes(to); }
    async run(initial, ctx) {
      let prev = null, cur = initial;
      while (cur) {
        const handler = this.handlers[cur];
        if (!handler) throw new Error(`FSM ${this.name}: không có trạng thái "${cur}"`);
        if (!this.canGo(prev, cur)) throw new Error(`FSM ${this.name}: chuyển ${prev} → ${cur} không hợp lệ`);
        this.state = cur;
        this.emit('enter', cur, prev);
        let next;
        try { next = await handler(ctx); } finally { this.emit('exit', cur); }
        prev = cur; cur = next || null;
      }
      this.state = null;
      this.emit('end', prev);
      return ctx;
    }
  }

  // Giới hạn tốc độ: dùng chung 1 mốc "đòn gần nhất" cho mọi chế độ; khoảng cách tối thiểu do engine đang đánh quyết định
  // (boss: BOSS_MIN_GAP_MS, tầm bảo / săn yêu: MATCH_MIN_GAP_MS)
  class RateLimiter {
    constructor() { this.last = 0; }
    pickJitter(rand) { return CFG.JITTER_MS[0] + rand() * (CFG.JITTER_MS[1] - CFG.JITTER_MS[0]); }
    // jitter truyền vào = dùng lại số đã bốc trước đó (để mốc đánh không đổi giữa lúc đọc chiêu và lúc đánh)
    async wait(sleep, now, rand, gap = CFG.MIN_GAP_MS, jitter = this.pickJitter(rand)) {
      const need = this.last + gap + jitter - now();
      if (need > 0) await sleep(need);
    }
    mark(t) { this.last = t; }
  }

  // 3 phút đầu mỗi giờ (theo đầu giờ UTC, giống phần quét boss): thời gian dành riêng cho boss
  const inBossWindow = nowMs => (((nowMs % 3600000) + 3600000) % 3600000) < CFG.BOSS_PRIORITY_WINDOW_MS;

  // Cờ ưu tiên giữa các chế độ: boss > U Minh Cốc > săn yêu > leo tháp > tầm bảo; bt = đang chờ để đột phá
  //  um       = đang ở trong phiên U Minh Cốc (săn yêu / tầm bảo không mở trận mới)
  //  umBattle = U Minh Cốc đang giữa một trận (boss chờ trận đó xong rồi mới đánh)
  class Coordinator {
    constructor() { this.boss = false; this.bossPending = false; this.farm = false; this.hunt = false; this.bt = false; this.btPause = false; this.btPauseSince = 0; this.btWake = false; this.um = false; this.umBattle = false; this.bossOn = false; this.tower = false; this.towerBattle = false; this.skillGate = null; }
    //  skillGate = hàm do App gắn: có lệnh đổi chiêu đang chờ và không còn trận nào dở thì đổi ngay (trả promise để chế độ gọi đợi), không có việc thì trả null
    //  bossPending = đang bật chế độ boss VÀ còn boss để đánh: U Minh Cốc không vào / không mở lượt mới (trong U Minh HP, MP không tự hồi theo thời gian; chỉ hồi được bằng đan)
    //  tower = leo tháp đang bật (tầm bảo nhường) | towerBattle = leo tháp đang giữa một trận
    //  btPause = đột phá đang chen vào: mọi chế độ đang đánh dừng trước đòn kế tiếp | btWake = có việc vừa xong (vd. đánh boss), đột phá kiểm tra tu vi ngay
    get fighting() { return this.boss || this.farm || this.hunt || this.umBattle || this.towerBattle; }
  }

  // Cấu hình dự phòng, KHÔNG theo chế độ: chỉ PillManager không có khóa chế độ (nút "Hồi MP ngay") dùng tới. Đan hồi MP của từng chế độ nằm ở MpPillConfig
  class PillConfig {
    constructor() { this.enabled = false; this.low = 0.2; this.high = 0.6; this.busy = false; }
  }
  // Cài đặt đan hồi HP theo từng chế độ (boss | farm | hunt | um | tower): bật/tắt + dùng đan khi HP < low, dùng tới khi HP >= target (0.05 … 0.95)
  // các chế độ có đan hồi HP / MP, chiêu hồi máu riêng
  const MODES5 = ['boss', 'hunt', 'farm', 'um', 'tower'];
  class HpPillConfig {
    constructor() {
      this.modes = {};
      for (const k of MODES5) this.modes[k] = { enabled: false, low: CFG.HP_PILL_TRIGGER_PCT, target: CFG.HP_PILL_DEFAULT_TARGET };
    }
  }
  // Mức hồi máu của CHIÊU hồi máu theo từng chế độ (boss | farm | hunt | um | tower; không có xuất hồn): dùng chiêu khi HP < low, dừng khi HP >= high (0.05 … 0.95)
  class HealSkillConfig {
    constructor() {
      this.modes = {};
      for (const k of MODES5) this.modes[k] = { low: CFG.HEAL_BELOW_PCT, high: CFG.HEAL_DEFAULT_HIGH };
    }
    // c = ngữ cảnh trận (nhớ c.healing giữa các đòn). Trả true / false, hoặc undefined nếu chế độ này không có cấu hình (dùng ngưỡng mặc định cũ)
    update(key, hp, hpMax, c) {
      const m = this.modes[key]; if (!m) return undefined;
      c.healing = SkillSelector.healWanted(hp, hpMax, c.healing, m.low, m.high);
      return c.healing;
    }
  }
  // Loại đan HP / MP đang chọn ở mục "Đan" + ảnh chụp túi đồ gần nhất (để hiện tồn kho). sel[kind] = { id, name } | null
  class PillBook extends EventEmitter {
    constructor() { super(); this.sel = { hp: null, mp: null }; this.inv = []; this.vals = { hp: null, mp: null }; } // vals = mức hồi của loại đang chọn (nhớ lại để chọn loại yếu hơn kế cận khi nó hết)
    static type(kind) { return kind === 'hp' ? 'heal_hp' : 'heal_mp'; }
    update(inventory) {
      if (Array.isArray(inventory)) {
        this.inv = inventory;
        for (const k of ['hp', 'mp']) { const s = this.sel[k], e = s && this.list(k).find(x => x.itemId === s.id); if (e) this.vals[k] = e.value; }
        this.emit('change');
      }
    }
    select(kind, id, name) {
      this.sel[kind] = id == null ? null : { id, name: name || '' };
      const e = id == null ? null : this.list(kind).find(x => x.itemId === id); if (e) this.vals[kind] = e.value;
      this.emit('change');
    }
    // Loại đang chọn đã hết hàng: chuyển sang loại đan THUẦN (không kèm công dụng khác) còn hàng, yếu hơn kế cận; không có loại yếu hơn thì loại mạnh hơn kế cận.
    // Trả về loại mới { itemId, name, value, qty } (đã chọn, phát 'autoswitch'), hoặc null nếu không phải đổi / không còn loại nào.
    switchIfEmpty(kind) {
      const s = this.sel[kind]; if (!s) return null;
      const l = this.list(kind);
      if (l.some(x => x.itemId === s.id)) return null; // vẫn còn hàng
      const pure = l.filter(x => x.pure); if (!pure.length) return null; // sắp từ yếu → mạnh
      const cur = this.vals[kind];
      let to;
      if (cur == null) to = pure[pure.length - 1];
      else { const weaker = pure.filter(x => x.value < cur); to = weaker.length ? weaker[weaker.length - 1] : (pure.find(x => x.value > cur) || pure[pure.length - 1]); }
      const from = s; this.select(kind, to.itemId, to.name); this.emit('autoswitch', { kind, from, to });
      return to;
    }
    list(kind) { return PillCatalog.list(this.inv, PillBook.type(kind)); }
    qty(kind) { const s = this.sel[kind]; const e = s && this.list(kind).find(x => x.itemId === s.id); return e ? e.qty : 0; }
    // chưa chọn gì thì chọn loại hồi nhiều nhất còn hàng. Trả về true nếu vừa chọn.
    autoSelect(kind) {
      if (this.sel[kind]) return false;
      const l = this.list(kind), e = l[l.length - 1];
      if (!e) return false;
      this.select(kind, e.itemId, e.name); return true;
    }
  }
  // Ngưỡng MP theo từng chế độ (farm | hunt | tower | um): MP% <= pause thì tạm dừng (không mở trận mới; U Minh: không vào), MP% > resume thì chạy tiếp. enabled = ô bật / tắt (mặc định bật)
  const GATE_MODES = ['farm', 'hunt', 'tower', 'um'];
  // Các cặp (ô tích + thanh trượt đôi) theo chế độ trên bảng: p = tiền tố id (#ab-<p>-<chế độ>), ev = tên sự kiện phát ra ('<ev>:toggle', '<ev>:range'), lo / hi = mặc định (%)
  const DUAL_SPECS = [
    { p: 'hp', ev: 'hp', modes: MODES5, lo: Math.round(CFG.HP_PILL_TRIGGER_PCT * 100), hi: Math.round(CFG.HP_PILL_DEFAULT_TARGET * 100), checked: false },
    { p: 'mp', ev: 'mp', modes: MODES5, lo: Math.round(CFG.MP_PILL_DEFAULT_LOW * 100), hi: Math.round(CFG.MP_PILL_DEFAULT_HIGH * 100), checked: false },
    { p: 'mg', ev: 'mgate', modes: GATE_MODES, lo: Math.round(CFG.FARM_MP_PAUSE_PCT * 100), hi: Math.round(CFG.FARM_MP_RESUME_PCT * 100), checked: true },
    { p: 'hg', ev: 'hgate', modes: GATE_MODES, lo: Math.round(CFG.HP_GATE_PAUSE_PCT * 100), hi: Math.round(CFG.HP_GATE_RESUME_PCT * 100), checked: true },
  ];
  class MpGate {
    static OFF = { enabled: false, pause: 0, resume: 0 };
    constructor() { this.modes = {}; for (const k of GATE_MODES) this.modes[k] = { enabled: true, pause: CFG.FARM_MP_PAUSE_PCT, resume: CFG.FARM_MP_RESUME_PCT }; }
  }
  // Ngưỡng HP theo từng chế độ (giống ngưỡng MP). U Minh: kiểm tra TRƯỚC khi vào vì trong đó HP, MP không tự hồi theo thời gian, chỉ hồi bằng đan
  class HpGate {
    static OFF = { enabled: false, pause: 0, resume: 0 };
    constructor() { this.modes = {}; for (const k of GATE_MODES) this.modes[k] = { enabled: true, pause: CFG.HP_GATE_PAUSE_PCT, resume: CFG.HP_GATE_RESUME_PCT }; }
  }
  // Đan hồi MP theo từng chế độ (boss | farm | hunt | um | tower): bật/tắt + dùng đan khi MP <= low, dùng tới khi MP >= high (0.05 … 0.95). busy dùng chung (không 2 chế độ cùng dùng đan)
  class MpPillConfig {
    constructor() {
      this.busy = false; this.modes = {};
      for (const k of MODES5) this.modes[k] = { enabled: false, low: CFG.MP_PILL_DEFAULT_LOW, high: CFG.MP_PILL_DEFAULT_HIGH };
    }
  }
  const newPillCfg = () => new PillConfig();
  const newMpGate = () => new MpGate();

  /* =====================================================================
   *  3. DỊCH VỤ DÙNG CHUNG
   * ===================================================================== */

  /**
   * Chờ dưỡng thương. Mỗi INJURY_CHECK_MS (15s) đọc HP; chỉ khi HP >= INJURY_RESUME_PCT (5%) HP tối đa mới
   * trả 'retry' để thử đánh lại. Không đọc được HP thì cũng thử lại (để game tự quyết định).
   * step() trả về: 'retry' | 'stopped' (bấm Tắt) | 'cancel' (stopWhen() báo thôi chờ) | kết quả của extraCheck() nếu có (vd 'ended')
   */
  class Healer extends EventEmitter {
    constructor(deps) {
      super();
      this.api = deps.api; this.sleep = deps.sleep;
      this.assist = null; // (hp, hpMax, alive) => Promise<{hp,hpMax}|null>: dùng đan hồi HP khi dưỡng thương (engine gắn vào)
      this.streak = 0; // số lần đã vào chờ liên tiếp (để chỉ báo mở đầu 1 lần)
      this.checks = 0; // số lần đã kiểm tra HP trong đợt chờ hiện tại (để giảm bớt log)
    }
    log(m) { this.emit('log', m); }
    async step(alive, stopWhen, extraCheck) {
      if (this.streak++ === 0) {
        this.checks = 0;
        this.log(`Đang trọng thương, cần dưỡng thương trước khi giao chiến. Chờ, kiểm tra HP mỗi ${CFG.INJURY_CHECK_MS / 1000}s, HP đạt ${Math.round(CFG.INJURY_RESUME_PCT * 100)}% là đánh tiếp.`);
      }
      for (;;) {
        if (this.assist && alive() && !(stopWhen && stopWhen()) && this.api.getMe) { // có đan hồi HP (đã bật cho chế độ này): dùng ngay, khỏi chờ HP tự hồi
          let m0 = null; try { m0 = await this.api.getMe(); } catch (_) {}
          if (m0 && typeof m0.hp === 'number' && m0.hp_max > 0 && m0.hp / m0.hp_max < CFG.INJURY_RESUME_PCT - 1e-9) {
            let out = null; try { out = await this.assist(m0.hp, m0.hp_max, alive); } catch (_) {}
            if (out) { this.log(`Dưỡng thương bằng đan hồi HP: HP ${out.hp}/${out.hpMax} (${(out.hp / out.hpMax * 100).toFixed(1)}%), đánh tiếp.`); this.streak = 0; return 'retry'; }
          }
        }
        for (let w = 0; w < CFG.INJURY_CHECK_MS && alive() && !(stopWhen && stopWhen()); w += 1000) await this.sleep(Math.min(1000, CFG.INJURY_CHECK_MS - w));
        if (!alive()) { this.streak = 0; return 'stopped'; }
        if (stopWhen && stopWhen()) { this.streak = 0; return 'cancel'; }
        if (extraCheck) { const x = await extraCheck(); if (x) { this.streak = 0; return x; } }
        let me = null;
        if (this.api.getMe) { try { me = await this.api.getMe(); } catch (_) {} }
        if (!me || typeof me.hp !== 'number' || !(me.hp_max > 0)) return 'retry';
        const p = me.hp / me.hp_max;
        const text = `HP ${me.hp}/${me.hp_max} (${(p * 100).toFixed(1)}%)`;
        if (p >= CFG.INJURY_RESUME_PCT - 1e-9) { this.log(`Dưỡng thương: ${text}, đã đạt ${Math.round(CFG.INJURY_RESUME_PCT * 100)}%, thử đánh lại...`); return 'retry'; }
        if (this.checks++ % 4 === 0) this.log(`Dưỡng thương: ${text}, chưa đạt ${Math.round(CFG.INJURY_RESUME_PCT * 100)}%, tiếp tục chờ...`);
      }
    }
    done() { if (this.streak) { this.log('Đã dưỡng thương xong, tiếp tục đánh.'); this.streak = 0; } }
  }

  class PillManager extends EventEmitter {
    // key = chế độ (boss | farm | hunt | um | tower): dùng cấu hình đan hồi MP riêng của chế độ đó (deps.mpCfg); không có thì dùng deps.pills (cấu hình chung kiểu cũ)
    constructor(deps, key = null) {
      super();
      this.api = deps.api; this.sleep = deps.sleep; this.now = deps.now;
      const root = deps.mpCfg, m = root && key ? root.modes[key] : null;
      this.cfg = m ? { get enabled() { return m.enabled; }, get low() { return m.low; }, get high() { return m.high; }, get busy() { return root.busy; }, set busy(v) { root.busy = v; } } : (deps.pills || new PillConfig());
      this.book = deps.pillBook || new PillBook();
      this.blockedUntil = 0;
    }
    log(m) { this.emit('log', m); }

    // Dùng đan nếu MP% <= low (hoặc force: đang thiếu MP cho chiêu). Dùng cho tới khi MP% >= high.
    // Trả về { mp, mpMax, hp } nếu đã dùng ít nhất 1 lần, ngược lại null (để engine chạy cách chờ MP như cũ).
    // manual = người dùng bấm nút "Hồi MP ngay": bỏ qua công tắc bật/tắt, ngưỡng thấp và thời gian tạm ngừng dùng đan.
    async topUp(mp, mpMax, alive, force, manual = false, target = null) {
      const { api, cfg } = this;
      const high = target == null ? cfg.high : manual ? target : Math.max(cfg.high, target); // hồi thủ công: tới mức ở thanh "Hồi ngay"; ngưỡng MP: ít nhất tới mức chạy tiếp
      if ((!cfg.enabled && !manual) || !api.getInventory || !api.useItem || cfg.busy) return null;
      if (typeof mp !== 'number' || !(mpMax > 0) || (!manual && this.now() < this.blockedUntil)) return null;
      if (mp / mpMax >= high || (!force && mp / mpMax > cfg.low)) return null;
      cfg.busy = true;
      let out = null;
      try {
        this.log(manual
          ? `Hồi MP thủ công: MP ${mp}/${mpMax} (${Math.round(mp / mpMax * 100)}%) → dùng đan hồi MP tới ${Math.round(high * 100)}%.`
          : `MP ${mp}/${mpMax} (${Math.round(mp / mpMax * 100)}%) ≤ ${Math.round(cfg.low * 100)}% → dùng đan hồi MP tới ${Math.round(high * 100)}%.`);
        let inv = await api.getInventory(1);
        this.book.update(inv);
        for (let step = 0; step < CFG.PILL_MAX_STEPS && alive() && (cfg.enabled || manual) && mp / mpMax < high; step++) {
          const chosen = this.book.sel.mp;
          let pill = PillCatalog.pick(inv, chosen ? chosen.id : null, 'heal_mp');
          if (!pill && chosen) { const to = this.book.switchIfEmpty('mp'); if (to) { this.log(`Hết ${chosen.name}, chuyển sang ${to.name} (hồi ${to.value} MP / viên).`); pill = PillCatalog.pick(inv, to.itemId, 'heal_mp'); } }
          if (!pill) {
            const what = chosen ? `đan hồi MP đã chọn (${chosen.name})` : 'đan hồi MP';
            this.log(manual ? `Hết ${what} trong túi.` : `Hết ${what} trong túi, quay lại chờ MP hồi tự nhiên (kiểm tra lại đan sau 5 phút).`);
            if (!manual) this.blockedUntil = this.now() + CFG.PILL_EMPTY_BLOCK_MS;
            break;
          }
          const need = Math.ceil((high * mpMax - mp) / pill.value);
          const qty = Math.max(1, Math.min(need, pill.qty, CFG.PILL_MAX_PER_USE));
          const d = await api.useItem(pill.id, qty, 1);
          const ch = d && d.character;
          if (!ch || typeof ch.mp !== 'number') throw new Error('phản hồi dùng đan không có MP');
          const gain = ch.mp - mp;
          mp = ch.mp; if (ch.mp_max > 0) mpMax = ch.mp_max;
          out = { mp, mpMax, hp: typeof ch.hp === 'number' ? ch.hp : undefined, hpMax: ch.hp_max };
          if (Array.isArray(d.inventory)) { inv = d.inventory; this.book.update(inv); }
          this.log(`🧪 Dùng ${qty}× ${pill.name}: MP ${mp}/${mpMax} (${Math.round(mp / mpMax * 100)}%)`);
          if (gain <= 0) {
            this.log(manual ? 'Dùng đan nhưng MP không tăng, dừng.' : 'Dùng đan nhưng MP không tăng, tạm ngừng dùng đan 1 phút.');
            if (!manual) this.blockedUntil = this.now() + CFG.PILL_ERROR_BLOCK_MS;
            break;
          }
          if (mp / mpMax < high) await this.sleep(CFG.PILL_STEP_GAP_MS);
        }
      } catch (e) {
        this.log(manual ? `Lỗi dùng đan hồi MP: ${e.message}.` : `Lỗi dùng đan hồi MP: ${e.message}. Tạm ngừng dùng đan 1 phút.`);
        if (!manual) this.blockedUntil = this.now() + CFG.PILL_ERROR_BLOCK_MS;
      } finally { cfg.busy = false; }
      return out;
    }

    // Nút "Hồi MP ngay": đọc MP hiện tại rồi dùng đan tới mức target (0.05 … 0.95, thanh "Hồi ngay"), không cần đang có trận chiến
    // và không cần bật đan hồi MP của chế độ nào. Trả về { mp, mpMax } nếu có dùng đan, ngược lại null.
    async refill(target = null, alive = () => true) {
      if (typeof target === 'function') { alive = target; target = null; } // tương thích kiểu gọi cũ refill(alive)
      const { api, cfg } = this;
      const goal = typeof target === 'number' ? target : cfg.high;
      if (cfg.busy) { this.log('Đang dùng đan hồi MP, đợi xong rồi bấm lại.'); return null; }
      let me;
      try { me = await api.getMe(); } catch (e) { this.log(`Lỗi đọc MP: ${e.message}`); return null; }
      if (!me || typeof me.mp !== 'number' || !(me.mp_max > 0)) { this.log('Không đọc được MP từ game.'); return null; }
      const hi = Math.round(goal * 100);
      if (me.mp / me.mp_max >= goal - 1e-9) { this.log(`MP ${me.mp}/${me.mp_max} (${Math.round(me.mp / me.mp_max * 100)}%) đã ≥ ${hi}%, không cần dùng đan.`); return null; }
      const out = await this.topUp(me.mp, me.mp_max, alive, true, true, goal);
      if (out) this.log(`Hồi MP xong: ${out.mp}/${out.mpMax} (${Math.round(out.mp / out.mpMax * 100)}%).`);
      return out;
    }
  }

  // Dùng đan hồi HP trong trận (mỗi chế độ một đối tượng, key = boss | farm | hunt | um). Dùng đan ĐÃ CHỌN ở mục "Đan".
  class HpPillService extends EventEmitter {
    constructor(deps, key) {
      super();
      this.api = deps.api; this.sleep = deps.sleep; this.now = deps.now;
      this.cfg = deps.hpCfg || new HpPillConfig();
      this.book = deps.pillBook || new PillBook();
      this.key = key; this.blockedUntil = 0; this.busy = false;
    }
    log(m) { this.emit('log', m); }
    get mode() { return this.cfg.modes[this.key] || null; }
    get enabled() { const m = this.mode; return !!(m && m.enabled); }
    // true = đan đang lo việc hồi HP của chế độ này (bật + đã chọn đan + còn đan + không bị tạm ngừng) → KHÔNG dùng chiêu heal.
    // false = bật chiêu heal (dự phòng): không bật nút, hết đan, hoặc dùng đan đang lỗi.
    covers() { return this.enabled && this.now() >= this.blockedUntil && this.book.qty('hp') > 0; }

    // HP% < mode.low (x%) thì dùng đan tới khi HP% ≥ mode.target (y%). Trả về { hp, hpMax, mp, mpMax } nếu đã dùng, ngược lại null.
    // force = true (ngưỡng HP trước khi vào trận): bỏ qua mức "bắt đầu dùng", dùng đan tới mức y% nếu HP còn thấp hơn y%.
    async topUp(hp, hpMax, alive, force = false, floor = null) { // floor = mức chạy tiếp của ngưỡng HP: khi force, dùng đan ít nhất tới mức này
      const { api } = this;
      if (!this.enabled || !api.getInventory || !api.useItem || this.busy) return null;
      if (typeof hp !== 'number' || !(hpMax > 0) || this.now() < this.blockedUntil) return null;
      const low = typeof this.mode.low === 'number' ? this.mode.low : CFG.HP_PILL_TRIGGER_PCT;
      const target = force && floor != null ? Math.max(this.mode.target, floor) : this.mode.target;
      if (!force && hp / hpMax >= low) return null;
      if (force && hp / hpMax >= target) return null;
      this.busy = true;
      let out = null;
      try {
        this.log(`HP ${hp}/${hpMax} (${Math.round(hp / hpMax * 100)}%) ${force ? 'dưới ngưỡng HP' : `< ${Math.round(low * 100)}%`} → dùng đan hồi HP tới ${Math.round(target * 100)}%.`);
        let inv = await api.getInventory(1);
        this.book.update(inv);
        for (let step = 0; step < CFG.PILL_MAX_STEPS && alive() && this.enabled && hp / hpMax < target; step++) {
          const chosen = this.book.sel.hp;
          let pill = chosen ? PillCatalog.pick(inv, chosen.id, 'heal_hp') : null;
          if (!pill && chosen) { const to = this.book.switchIfEmpty('hp'); if (to) { this.log(`Hết ${chosen.name}, chuyển sang ${to.name} (hồi ${to.value} HP / viên).`); pill = PillCatalog.pick(inv, to.itemId, 'heal_hp'); } }
          if (!pill) {
            this.log(chosen ? `Hết đan hồi HP đã chọn (${chosen.name}) → dùng chiêu heal trong bộ skill (kiểm tra lại đan sau 5 phút).` : 'Chưa chọn đan hồi HP ở mục "Đan" → dùng chiêu heal trong bộ skill.');
            this.blockedUntil = this.now() + CFG.PILL_EMPTY_BLOCK_MS;
            break;
          }
          const need = Math.ceil((target * hpMax - hp) / pill.value);
          const qty = Math.max(1, Math.min(need, pill.qty, CFG.PILL_MAX_PER_USE));
          const d = await api.useItem(pill.id, qty, 1);
          const ch = d && d.character;
          if (!ch || typeof ch.hp !== 'number') throw new Error('phản hồi dùng đan không có HP');
          const gain = ch.hp - hp;
          hp = ch.hp; if (ch.hp_max > 0) hpMax = ch.hp_max;
          out = { hp, hpMax, mp: typeof ch.mp === 'number' ? ch.mp : undefined, mpMax: ch.mp_max };
          if (Array.isArray(d.inventory)) { inv = d.inventory; this.book.update(inv); }
          this.log(`🧪 Dùng ${qty}× ${pill.name}: HP ${hp}/${hpMax} (${Math.round(hp / hpMax * 100)}%)`);
          if (gain <= 0) { this.log('Dùng đan nhưng HP không tăng, tạm ngừng dùng đan HP 1 phút (dùng chiêu heal nếu có).'); this.blockedUntil = this.now() + CFG.PILL_ERROR_BLOCK_MS; break; }
          if (hp / hpMax < target) await this.sleep(CFG.PILL_STEP_GAP_MS);
        }
        if (!this.book.qty('hp')) this.blockedUntil = Math.max(this.blockedUntil, this.now() + CFG.PILL_EMPTY_BLOCK_MS); // dùng hết sạch
      } catch (e) {
        this.log(`Lỗi dùng đan hồi HP: ${e.message}. Tạm ngừng dùng đan HP 1 phút (dùng chiêu heal nếu có).`);
        this.blockedUntil = this.now() + CFG.PILL_ERROR_BLOCK_MS;
      } finally { this.busy = false; }
      return out;
    }

    // Nút "Hồi HP ngay": đọc HP hiện tại rồi dùng đan hồi HP đã chọn tới mức target (0.05 … 0.95), không cần đang có trận và không cần bật dùng đan của chế độ nào.
    // Trả về { hp, hpMax } nếu có dùng đan, ngược lại null.
    async refill(target, alive = () => true) {
      const { api } = this;
      if (this.busy) { this.log('Đang dùng đan hồi HP, đợi xong rồi bấm lại.'); return null; }
      if (!api.getMe || !api.getInventory || !api.useItem) return null;
      let me;
      try { me = await api.getMe(); } catch (e) { this.log(`Lỗi đọc HP: ${e.message}`); return null; }
      if (!me || typeof me.hp !== 'number' || !(me.hp_max > 0)) { this.log('Không đọc được HP từ game.'); return null; }
      let hp = me.hp, hpMax = me.hp_max; const pct = Math.round(target * 100);
      if (hp / hpMax >= target - 1e-9) { this.log(`HP ${hp}/${hpMax} (${Math.round(hp / hpMax * 100)}%) đã ≥ ${pct}%, không cần dùng đan.`); return null; }
      this.busy = true;
      let out = null;
      try {
        this.log(`Hồi HP thủ công: HP ${hp}/${hpMax} (${Math.round(hp / hpMax * 100)}%) → dùng đan hồi HP tới ${pct}%.`);
        let inv = await api.getInventory(1);
        this.book.update(inv);
        for (let step = 0; step < CFG.PILL_MAX_STEPS && alive() && hp / hpMax < target - 1e-9; step++) {
          const chosen = this.book.sel.hp;
          let pill = chosen ? PillCatalog.pick(inv, chosen.id, 'heal_hp') : null;
          if (!pill && chosen) { const to = this.book.switchIfEmpty('hp'); if (to) { this.log(`Hết ${chosen.name}, chuyển sang ${to.name} (hồi ${to.value} HP / viên).`); pill = PillCatalog.pick(inv, to.itemId, 'heal_hp'); } }
          if (!pill) { this.log(chosen ? `Hết đan hồi HP đã chọn (${chosen.name}) trong túi.` : 'Chưa chọn đan hồi HP ở mục "Đan".'); break; }
          const need = Math.ceil((target * hpMax - hp) / pill.value);
          const qty = Math.max(1, Math.min(need, pill.qty, CFG.PILL_MAX_PER_USE));
          const d = await api.useItem(pill.id, qty, 1);
          const ch = d && d.character;
          if (!ch || typeof ch.hp !== 'number') throw new Error('phản hồi dùng đan không có HP');
          const gain = ch.hp - hp;
          hp = ch.hp; if (ch.hp_max > 0) hpMax = ch.hp_max;
          out = { hp, hpMax };
          if (Array.isArray(d.inventory)) { inv = d.inventory; this.book.update(inv); }
          this.log(`🧪 Dùng ${qty}× ${pill.name}: HP ${hp}/${hpMax} (${Math.round(hp / hpMax * 100)}%)`);
          if (gain <= 0) { this.log('Dùng đan nhưng HP không tăng, dừng.'); break; }
          if (hp / hpMax < target - 1e-9) await this.sleep(CFG.PILL_STEP_GAP_MS);
        }
      } catch (e) { this.log(`Lỗi dùng đan hồi HP: ${e.message}.`); }
      finally { this.busy = false; }
      if (out) this.log(`Hồi HP xong: ${out.hp}/${out.hpMax} (${Math.round(out.hp / out.hpMax * 100)}%).`);
      return out;
    }
  }

  /* =====================================================================
   *  4. ENGINE
   * ===================================================================== */

  /**
   * Lớp cơ sở cho mọi chế độ tự động. KHÔNG biết gì về DOM: giao tiếp với bên ngoài chỉ qua sự kiện
   *   'start' | 'stop' | 'log'(message) | 'state'({engine, from, to}) và các sự kiện riêng của từng engine.
   * Lớp con khai báo startMessage / stopMessage / releaseFlags() / execute(alive).
   */
  // Tự đổi chiêu khắc hệ trước khi đánh boss (xem SkillCatalog.plan). Dùng chung 1 đối tượng; chạy từng lần một.
  class SkillSwapper extends EventEmitter {
    constructor(deps) {
      super();
      this.api = deps.api; this.sleep = deps.sleep || (() => Promise.resolve());
      this.enabled = true; this.busy = false; this.realm = null;
      this.pool = new Set(); this.locked = new Set(); // id (inventory) chiêu được phép gắn / chiêu bị khóa
    }
    log(m) { this.emit('log', m); }
    // Trả về true nếu đã đổi chiêu. Lỗi thì ghi log, không ném.
    async ensureFor(el, who) {
      if (!this.enabled || !el || this.busy) return false;
      this.busy = true; let freed = null;
      try {
        const [book, me] = await Promise.all([this.api.getSkillBook(), this.api.getMe ? this.api.getMe().catch(() => null) : null]);
        const inv = book.skills; this.slots = book.slots;
        if (me && typeof me.realm_id === 'number') this.realm = me.realm_id; // cảnh giới có thể vừa đột phá: đọc lại mỗi lần
        const realm = this.realm;
        const plan = SkillCatalog.plan(inv, el, realm, { pool: this.pool, locked: this.locked, slots: book.slots });
        if (plan.reason === 'nopool') { this.log(`Bộ chiêu đang mang không có chiêu công kích khắc ${el} nhưng chưa chọn chiêu dự bị ("Chiêu dùng để thay") nên không đổi (${who}), giữ nguyên bộ chiêu.`); return false; }
        if (plan.reason === 'none') { this.log(`Bộ chiêu đang mang không có chiêu công kích khắc ${el} và chiêu dự bị cũng không có chiêu khắc nào dùng được (${who}), giữ nguyên bộ chiêu.`); return false; }
        if (plan.reason === 'locked') { this.log(`Có chiêu dự bị khắc ${el} nhưng không có chiêu nào tháo được (bị khóa 🔒 hoặc là chiêu hồi máu duy nhất) (${who}), giữ nguyên bộ chiêu.`); return false; }
        if (!plan.actions.length) return false;
        const nm = x => `"${x.name}" (${x.skill_element}${x.skill_kind === 'attack' ? ' ×' + Number(x.skill_damage_multiplier) : ', hồi máu'})`;
        this.log(`Đổi chiêu khắc ${el} cho ${who}: ${plan.actions.map(a => `${a.op === 'equip' ? 'gắn' : 'tháo'} ${a.op === 'equip' ? nm(a.item) : `"${a.item.name}"`}`).join(', ')}.`);
        let cur = inv; freed = null;
        for (const a of plan.actions) {
          const d = await (a.op === 'equip' ? this.api.equipSkill(a.item.id) : this.api.unequipSkill(a.item.id));
          freed = a.op === 'unequip' ? a.item : null; // đã tháo mà chưa gắn được chiêu mới thì phải trả lại (catch bên dưới)
          if (d && Array.isArray(d.skills)) { cur = d.skills; this.slots = d.slots; }
          await this.sleep(CFG.SWAP_CALL_GAP_MS);
        }
        const rot = SkillCatalog.rotatePool(plan.actions.filter(a => a.op === 'equip').map(a => a.item), plan.actions.filter(a => a.op === 'unequip').map(a => a.item), [...this.pool], this.locked);
        if (rot.changes.length) { this.pool = new Set(rot.pool); this.emit('pool', rot); }
        this.emit('change', cur, this.slots);
        return true;
      } catch (e) {
        this.log(`Lỗi đổi chiêu: ${e.message}`);
        if (freed) { try { await this.api.equipSkill(freed.id); this.log(`Đã gắn lại chiêu "${freed.name}" vừa tháo.`); } catch (e2) { this.log(`Không gắn lại được chiêu "${freed.name}": ${e2.message}. Hãy gắn lại bằng tay.`); } }
        try { const b = await this.api.getSkillBook(); this.emit('change', b.skills, b.slots); } catch (_) {}
        return false;
      } finally { this.busy = false; }
    }
    // Đổi bộ chiêu cho Tông Chiến (gọi ngay trước khi vào lãnh địa). Trả 'ok' (không cần đổi / tắt đổi chiêu), 'changed' hoặc 'error' (đã tháo mà chưa gắn được thì gắn lại chiêu cũ).
    async ensureWar(who) {
      if (!this.enabled) { this.log(`Tự đổi chiêu đang tắt, giữ nguyên bộ chiêu cho ${who}.`); return 'ok'; }
      if (this.busy) return 'error';
      this.busy = true; const freed = [];
      try {
        const [book, me] = await Promise.all([this.api.getSkillBook(), this.api.getMe ? this.api.getMe().catch(() => null) : null]);
        this.slots = book.slots;
        if (me && typeof me.realm_id === 'number') this.realm = me.realm_id;
        const plan = SkillCatalog.planWar(book.skills, this.realm, { locked: this.locked, slots: book.slots });
        if (!plan.actions.length) return 'ok';
        this.log(`Đổi chiêu cho ${who} (server chụp bộ chiêu lúc vào): ${plan.actions.map(a => `${a.op === 'equip' ? 'gắn' : 'tháo'} "${a.item.name}"`).join(', ')}.`);
        let cur = book.skills;
        for (const a of plan.actions) {
          const d = await (a.op === 'equip' ? this.api.equipSkill(a.item.id) : this.api.unequipSkill(a.item.id));
          if (a.op === 'unequip') freed.push(a.item); else { const i = freed.findIndex(f => f.id === a.item.id); if (i >= 0) freed.splice(i, 1); }
          if (d && Array.isArray(d.skills)) { cur = d.skills; this.slots = d.slots; }
          await this.sleep(CFG.SWAP_CALL_GAP_MS);
        }
        const rot = SkillCatalog.rotatePool(plan.actions.filter(a => a.op === 'equip').map(a => a.item), plan.actions.filter(a => a.op === 'unequip').map(a => a.item), [...this.pool], this.locked);
        if (rot.changes.length) { this.pool = new Set(rot.pool); this.emit('pool', rot); }
        this.emit('change', cur, this.slots);
        return 'changed';
      } catch (e) {
        this.log(`Lỗi đổi chiêu: ${e.message}`);
        for (const f of freed) { try { await this.api.equipSkill(f.id); this.log(`Đã gắn lại chiêu "${f.name}" vừa tháo.`); } catch (e2) { this.log(`Không gắn lại được chiêu "${f.name}": ${e2.message}. Hãy gắn lại bằng tay.`); } }
        try { const b = await this.api.getSkillBook(); this.emit('change', b.skills, b.slots); } catch (_) {}
        return 'error';
      } finally { this.busy = false; }
    }
  }

  class Engine extends EventEmitter {
    constructor(deps) {
      super();
      this.api = deps.api; this.sleep = deps.sleep; this.now = deps.now; this.rand = deps.rand;
      this.limiter = deps.limiter || new RateLimiter();
      this.coord = deps.coord || new Coordinator();
      this.swapper = deps.swapper || null; // tự đổi chiêu khắc hệ (chỉ boss), có thể không có
      this.st = { running: false, errors: 0, gen: 0 };
      // tương thích kiểu cũ: deps.log / deps.onStop vẫn dùng được, chỉ là đăng ký listener
      if (deps.log) this.on('log', deps.log);
      if (deps.onStop) this.on('stop', deps.onStop);
    }
    get startMessage() { return ''; }
    get stopMessage() { return ''; }
    log(m) { this.emit('log', m); }
    stop() { this.st.running = false; }
    releaseFlags() {}
    async swapSkills(el, who) { return this.swapper ? this.swapper.ensureFor(el, who) : false; }
    async execute(/* alive */) { throw new Error('execute() chưa được cài đặt'); }

    // gắn 1 dịch vụ con (Healer, PillManager...) để log của nó đi qua engine này
    attach(component) { component.on('log', m => this.log(m)); return component; }
    // gắn máy trạng thái để chuyển tiếp sự kiện chuyển trạng thái ra ngoài (phục vụ debug / UI nếu cần)
    track(machine) { machine.on('enter', (to, from) => this.emit('state', { engine: machine.name, from, to })); return machine; }

    get minGapMs() { return CFG.MIN_GAP_MS; } // lớp con ghi đè để có khoảng cách riêng
    async waitGap(jitter) {
      const co = this.coord; let said = false; // đột phá đang chen vào: dừng trước đòn / bước kế tiếp (tối đa BT_HOLD_MAX_MS)
      while (co && co.btPause && this.st.running && this.now() - co.btPauseSince < CFG.BT_HOLD_MAX_MS) { if (!said) { said = true; this.log('Đột phá đang chen vào, tạm dừng giữa trận...'); } await this.sleep(300); }
      await this.limiter.wait(this.sleep, this.now, this.rand, this.minGapMs, jitter); }
    markAttack() { this.limiter.mark(this.now()); }

    // Đọc lại bộ chiêu đang trang bị (c.skills) để đổi chiêu trong game có hiệu lực ngay ở đòn kế tiếp.
    // Lỗi mạng / phản hồi lạ / API không có thì giữ bộ cũ, không làm hỏng vòng đánh.
    async refreshSkills(c) {
      if (!this.api.getSkills || c.frozen) return; // c.frozen: server đã từ chối chiêu mới trong trận này, giữ bộ chiêu lúc bắt đầu trận
      let fresh;
      try { fresh = await this.api.getSkills(); } catch (_) { return; }
      if (!Array.isArray(fresh)) return;
      const sig = list => (list || []).map(s => [s.id, s.element, s.type, s.mp_cost, s.damage_multiplier].join(':')).sort().join('|');
      if (sig(fresh) === sig(c.skills)) return;
      c.skills = fresh;
      this.log(`Đã cập nhật chiêu thức: ${fresh.length ? fresh.map(s => `${s.name || '#' + s.id} (${s.element})`).join(', ') : '(chưa trang bị chiêu nào)'}`);
    }

    // Đang trong 3 phút đầu giờ dành cho boss (chỉ khi auto boss đang bật)?
    get bossWindow() { return !!this.coord.bossOn && inBossWindow(this.now()); }
    // Trong 3 phút đó mà đang có boss đánh → thu hoạch / luyện đan nhường. Chờ tới khi boss xong hoặc hết 3 phút.
    async yieldToBossFight(alive, who) {
      let logged = false;
      while (alive() && this.bossWindow && this.coord.boss) {
        if (!logged) { this.log(`Đang đánh boss trong 3 phút đầu giờ, ${who} tạm nhường...`); logged = true; }
        await this.sleep(1000);
      }
    }

    async exploreBreak() { await this.sleep(CFG.EXPLORE_PAUSE_MS[0] + this.rand() * (CFG.EXPLORE_PAUSE_MS[1] - CFG.EXPLORE_PAUSE_MS[0])); }

    // Thời gian chờ sau lỗi theo số lần lỗi liên tiếp (st.errors): 10s, 20s, 30s rồi giữ 2 phút. Boss ghi đè: cố định.
    errWaitMs() {
      const steps = CFG.ERR_BACKOFF_STEPS_MS, n = Math.max(1, this.st.errors || 0);
      return n <= steps.length ? steps[n - 1] : CFG.ERR_BACKOFF_CAP_MS;
    }
    errWaitSec() { return Math.round(this.errWaitMs() / 1000); }

    // Thiếu cấu hình (chưa chọn đan / hạt giống, đan bị khóa...): ghi log, chờ CONFIG_WAIT_MS rồi để vòng lặp đọc lại, không tự tắt.
    async waitConfig(alive, msg) {
      this.log(`${msg}. Chờ ${CFG.CONFIG_WAIT_MS / 1000}s rồi đọc lại, tự chạy tiếp khi hợp lệ.`);
      await sleepSlices(this.sleep, CFG.CONFIG_WAIT_MS, alive);
    }

    // Cổng đổi chiêu: gọi ngay trước khi mở một trận mới (lúc cờ đánh của chế độ này còn tắt). Có lệnh đổi chiêu đang chờ thì đợi tool đổi xong rồi mới mở trận
    async skillGate() {
      const g = this.coord && this.coord.skillGate;
      if (typeof g !== 'function') return;
      try { await g(); } catch (_) {}
    }

    // Game từ chối vì đang xuất hồn: đọc trạng thái, đợi lượt xong (xong rồi thì nhận thưởng) rồi trả true để chế độ này đi tiếp.
    // false = lỗi này không liên quan tới xuất hồn (không có lượt nào đang chạy và lời báo lỗi không nhắc tới xuất hồn).
    // abandon = true (tầm bảo / U Minh Cốc không chạy song song với xuất hồn): lượt xuất hồn đang chạy dở thì BỎ lượt đó (mất thưởng) để nhường chỗ;
    // lượt đã xong thì vẫn nhận thưởng. Bỏ không được thì chờ xong như cũ.
    async waitXuatHon(alive, e, abandon = false) {
      if (!this.api.xhStatus) return false;
      let s; try { s = await this.api.xhStatus(); } catch (_) { return false; }
      const hinted = /xuất hồn|xuat hon/i.test((e && e.message) || '');
      if (!s) { if (!hinted) return false; await this.sleep(1500); return true; }
      let logged = false;
      while (alive() && s) {
        if (s.ready) {
          try { const d = await this.api.xhClaim(); this.log(`Xuất hồn đã xong, nhận được thưởng: +${(d && d.expGained) || 0} tu vi, +${(d && d.lockedSpiritStonesGained) || 0} linh thạch khóa.`); } catch (_) {}
          break;
        }
        if (abandon && this.api.xhAbandon) {
          try { await this.api.xhAbandon(); this.log(`Đang xuất hồn${s.dungeonName ? ` (${s.dungeonName})` : ''}, còn ${fmtSec(s.secondsRemaining)}: bỏ lượt này (mất thưởng) để nhường chỗ, đi tiếp.`); return true; }
          catch (err) { this.log(`Không bỏ được lượt xuất hồn (${err.message}), chờ xong rồi đi tiếp.`); abandon = false; }
        }
        if (!logged) { logged = true; this.log(`Đang xuất hồn${s.dungeonName ? ` (${s.dungeonName})` : ''}, còn ${fmtSec(s.secondsRemaining)}: chờ xong rồi đi tiếp.`); }
        await sleepSlices(this.sleep, Math.min(CFG.XH_POLL_MS, ((Number(s.secondsRemaining) || 0) + 1.5) * 1000), alive);
        if (!alive()) return true;
        try { s = await this.api.xhStatus(); } catch (_) { break; }
      }
      return true;
    }

    // Không có chiêu tấn công nào dùng được: chờ, đọc lại bộ chiêu + MP (c.skills, c.mp), nhắc log tối đa mỗi NOSKILL_LOG_EVERY_MS
    async waitSkills(c) {
      const now = this.now();
      if (!this._noSkillLogAt || now - this._noSkillLogAt >= CFG.NOSKILL_LOG_EVERY_MS) {
        this._noSkillLogAt = now;
        this.log(`Chưa có chiêu tấn công nào dùng được trong bộ chiêu. Chờ ${CFG.NOSKILL_WAIT_MS / 1000}s rồi đọc lại chiêu và MP, có chiêu là đánh tiếp (hãy trang bị chiêu).`);
      }
      await sleepSlices(this.sleep, CFG.NOSKILL_WAIT_MS, c.alive);
      if (!c.alive()) return;
      c.frozen = false;
      try { const fresh = await this.api.getSkills(); if (Array.isArray(fresh)) c.skills = fresh; } catch (_) {}
      if (this.api.getMe) { try { const me = await this.api.getMe(); if (me && typeof me.mp === 'number') c.mp = me.mp; } catch (_) {} }
    }

    // Theo dõi lỗi lặp: 'ok' | 'reset' (lần đầu đủ REPEAT_ERR_RESET lần liên tiếp) | 'hold' (sau reset vẫn lặp thêm REPEAT_ERR_AFTER_RESET lần)
    trackError(e) {
      const sig = String((e && e.message) || e).replace(/\d+/g, 'N').slice(0, 120);
      let r = this.rep;
      if (!r || r.sig !== sig) r = this.rep = { sig, n: 0, resets: 0 };
      r.n++;
      if (r.resets === 0 && r.n >= CFG.REPEAT_ERR_RESET) { r.n = 0; r.resets = 1; return 'reset'; }
      if (r.resets > 0 && r.n >= CFG.REPEAT_ERR_AFTER_RESET) { r.n = 0; r.resets++; return 'hold'; }
      return 'ok';
    }
    clearErrors() { this.rep = null; }
    // Reset mềm: engine thoát vòng hiện tại, nhả cờ, xóa lỗi và chạy lại từ đầu (đọc lại trạng thái từ server). Không tắt chế độ.
    softReset() { this.st.resetFlag = true; }
    // Chế độ đang bật mà lỗi liên tục (st.errors > 0, không có lần thành công nào) quá WATCHDOG_IDLE_MS → reset mềm
    watchdog(now) {
      const st = this.st;
      if (!CFG.WATCHDOG_IDLE_MS || !st.running || !(st.errors > 0)) { this.wdSince = null; return false; }
      if (this.wdSince == null) { this.wdSince = now; return false; }
      if (now - this.wdSince < CFG.WATCHDOG_IDLE_MS) return false;
      this.wdSince = null;
      this.log(`Watchdog: lỗi liên tục ${Math.round(CFG.WATCHDOG_IDLE_MS / 60000)} phút mà không thành công lần nào → reset mềm, đọc lại trạng thái.`);
      this.softReset();
      return true;
    }

    async run() {
      const st = this.st;
      if (st.running) return;
      st.running = true; st.errors = 0; st.bagFull = false;
      const gen = ++st.gen;
      const live = () => st.running && st.gen === gen;
      const alive = () => live() && !st.resetFlag; // resetFlag: reset mềm đang yêu cầu, các vòng chờ thoát ra để chạy lại
      this.emit('start');
      this.log(this.startMessage);
      try {
        while (live()) { // lỗi bất ngờ ở vòng ngoài: không tắt, chờ theo lịch lùi rồi chạy lại
          try {
            await this.execute(alive);
            if (st.resetFlag && live()) { st.resetFlag = false; st.errors = 0; this.rep = null; this.releaseFlags(); this.log('Reset mềm: chạy lại từ đầu.'); continue; }
            break;
          } catch (e) {
            st.errors++;
            this.releaseFlags();
            this.log(`Lỗi: ${e.message}. Không tắt, chạy lại sau ${this.errWaitSec()}s...`);
            await sleepSlices(this.sleep, this.errWaitMs(), live);
            st.resetFlag = false;
          }
        }
      }
      catch (e) { this.log(`Lỗi: ${e.message}`); if (st.gen === gen) st.running = false; }
      finally {
        if (st.gen === gen) { st.running = false; this.releaseFlags(); this.log(this.stopMessage); this.emit('stop'); }
      }
    }
  }

  /* ---------------------------------------------------------------------
   *  BOSS
   *  FSM: LOAD → PICK → (IDLE_WAIT → LOAD) | ENTER → YIELD → CHECK → PILL → CHOOSE → GAP → ATTACK → RESOLVE → YIELD ...
   *       các nhánh phụ: WAIT_MP (hết MP), RECOVER (trọng thương), EXIT (rời trận) → LOAD
   * --------------------------------------------------------------------- */
  class BossEngine extends Engine {
    constructor(deps) {
      super(deps);
      Object.assign(this.st, { enabled: { small: true, medium: true, large: true }, modes: { small: 'full', medium: 'full', large: 'full' }, paused: new Map(), gaveUp: new Set(), logged: new Set() }); // paused: id boss đang chờ last hit → lúc bắt đầu chờ; gaveUp: boss bỏ vì chờ quá lâu
      this.healer = this.attach(new Healer(deps));
      this.pills = this.attach(new PillManager(deps, this.hpKey));
      this.hpPills = this.attach(new HpPillService(deps, this.hpKey));
      this.healCfg = deps.healCfg || new HealSkillConfig();
      this.healer.assist = (hp, hpMax, alive) => this.hpPills.topUp(hp, hpMax, alive);
      this.machine = this.track(new StateMachine('boss', {
        LOAD: c => this.sLoad(c), PICK: c => this.sPick(c), IDLE_WAIT: c => this.sIdleWait(c),
        ENTER: c => this.sEnter(c), YIELD: c => this.sYield(c), CHECK: c => this.sCheck(c), REFRESH: c => this.sRefresh(c),
        PILL: c => this.sPill(c), CHOOSE: c => this.sChoose(c), WAIT_MP: c => this.sWaitMp(c),
        GAP: c => this.sGap(c), ATTACK: c => this.sAttack(c), RECOVER: c => this.sRecover(c),
        RESOLVE: c => this.sResolve(c), EXIT: c => this.sExit(c),
      }, BossEngine.TRANSITIONS));
    }
    get hpKey() { return 'boss'; }
    get minGapMs() { return CFG.BOSS_MIN_GAP_MS; }
    errWaitMs() { return CFG.BOSS_ERROR_RETRY_MS; }
    get startMessage() { return 'BẮT ĐẦU auto boss.'; }
    get stopMessage() { return 'ĐÃ DỪNG.'; }
    releaseFlags() { this.coord.boss = false; this.coord.bossOn = false; this.coord.bossPending = false; }

    // Boss lỗi thì không tắt: ghi log, nghỉ BOSS_ERROR_RETRY_MS rồi chạy lại từ đầu (quét boss), lặp tới khi người dùng bấm Tắt.
    async execute(alive) {
      this.coord.bossOn = true;
      while (alive()) {
        try {
          await this.machine.run('LOAD', {
            alive, list: null, skills: null, boss: null, sp: null, act: null, res: null,
            mp: null, vit: null, warnedHeal: false, idleLogged: false,
          });
          return;
        } catch (e) {
          this.coord.boss = false;
          this.log(`Lỗi: ${e.message}. Không tắt, quét lại sau ${CFG.BOSS_ERROR_RETRY_MS / 1000}s...`);
          await sleepSlices(this.sleep, CFG.BOSS_ERROR_RETRY_MS, alive);
        }
      }
    }

    // Loại boss này còn được tích chọn không (đọc lại mỗi lần, vì người dùng có thể bỏ tích bất cứ lúc nào)
    isEnabled(boss) { return this.st.enabled[boss.size] !== false; }
    skipDisabled(boss) { this.log(`Đã bỏ chọn boss ${SIZE_NAME[boss.size]}, ngừng đánh boss #${boss.id}.`); return 'EXIT'; }
    ended(sp) { return sp.status !== 'active' || sp.hp <= 0 || (sp.expires_at && Date.parse(sp.expires_at) <= this.now()); }
    readVitals(c, me) {
      if (!me) return;
      if (typeof me.hp === 'number') c.vit.hp = me.hp;
      if (me.hp_max > 0) c.vit.hpMax = me.hp_max;
      if (me.mp_max > 0) c.vit.mpMax = me.mp_max;
    }

    async sLoad(c) {
      if (!c.alive()) return null;
      const { st, api } = this;
      try { c.list = await api.getActive(); if (!c.skills) c.skills = await api.getSkills(); } // chiêu được đọc lại trước mỗi đòn (sRefresh), nên quét boss dày không cần tải lại
      catch (e) {
        this.log(`Lỗi tải dữ liệu: ${e.message}. Quét lại sau ${CFG.BOSS_ERROR_RETRY_MS / 1000}s.`);
        await sleepSlices(this.sleep, CFG.BOSS_ERROR_RETRY_MS, c.alive); // không tắt, chỉ chờ rồi quét lại
        return 'LOAD';
      }
      return 'PICK';
    }

    async sPick(c) {
      const { st } = this, now = this.now(); let list = (c.list || []).filter(b => !st.gaveUp.has(b.id));
      const opt = { modes: st.modes, paused: st.paused };
      for (const [id, since] of [...st.paused]) {
        if (!list.some(b => b.id === id && BossCatalog.active(b, now))) { st.paused.delete(id); continue; } // boss đã hết: bỏ theo dõi
        const b = list.find(x => x.id === id);
        if (now - since > CFG.BOSS_LASTHIT_WAIT_MS && !BossCatalog.eligible(b, st.modes, st.paused)) { // chờ quá lâu: bỏ boss này, nhả U Minh Cốc
          st.paused.delete(id); st.gaveUp.add(id);
          this.log(`Chờ last hit boss #${id} quá ${Math.round(CFG.BOSS_LASTHIT_WAIT_MS / 60000)} phút (còn ${Math.round(BossCatalog.pct(b) * 100)}% HP), bỏ boss này để các chế độ khác chạy.`);
        }
      }
      list = list.filter(b => !st.gaveUp.has(b.id)); // boss vừa bỏ ở trên cũng loại khỏi danh sách
      const boss = BossCatalog.pick(list, st.enabled, now, opt);
      const waiting = list.filter(b => st.paused.has(b.id) && st.enabled[b.size] && BossCatalog.active(b, now) && !BossCatalog.eligible(b, st.modes, st.paused));
      for (const b of list) { // báo 1 lần cho mỗi boss bị bỏ qua vì chế độ "≥ 70% HP"
        if (BossCatalog.active(b, now) && st.enabled[b.size] && !BossCatalog.eligible(b, st.modes, st.paused) && !st.paused.has(b.id) && !st.logged.has(b.id)) {
          st.logged.add(b.id); this.log(`Bỏ qua ${SIZE_NAME[b.size]} "${b.name}" #${b.id}: còn ${Math.round(BossCatalog.pct(b) * 100)}% HP, thấp hơn ${BossCatalog.ENTRY_MIN * 100}% (chế độ của cỡ này).`);
        }
      }
      this.coord.bossPending = !!boss || waiting.length > 0; // còn boss để đánh (kể cả đang chờ last hit) → U Minh Cốc không vào / không mở lượt mới
      c.waitPct = waiting.length ? Math.min(...waiting.map(BossCatalog.pct)) : null;
      if (!boss) {
        if (waiting.length) { if (!c.idleLogged) { this.log(`Chờ last hit: boss còn ${Math.round(c.waitPct * 100)}% HP, đánh tiếp khi còn ≤ ${BossCatalog.LAST_HIT * 100}%. Các chế độ khác (trừ U Minh Cốc) vẫn chạy.`); c.idleLogged = true; } return 'IDLE_WAIT'; }
        if (!c.idleLogged) { this.log(`Chưa có boss nào để đánh, tự quét lại mỗi ${CFG.IDLE_POLL_MS / 1000}s...`); c.idleLogged = true; }
        return 'IDLE_WAIT';
      }
      c.idleLogged = false; c.boss = boss;
      return 'ENTER';
    }

    // Boss chỉ xuất hiện đầu mỗi giờ: trong BOSS_SPAWN_WINDOW_MS đầu giờ thì quét mỗi IDLE_POLL_MS,
    // quá cửa sổ đó thì ngủ tới đầu giờ kế tiếp rồi mới quét lại.
    async sIdleWait(c) {
      const H = 3600000, now = this.now(), start = Math.floor(now / H) * H;
      if (c.waitPct != null) { // đang chờ last hit: quét dày dần khi boss gần mốc (dưới 10%: 2s một lần, không dày hơn để khỏi chiếm hết hàng chờ của chế độ khác)
        const poll = c.waitPct > 0.3 ? 10000 : c.waitPct > 0.1 ? 3000 : 2000;
        for (let w = 0; w < poll && c.alive(); w += 1000) await this.sleep(Math.min(1000, poll - w));
        return 'LOAD';
      }
      if (now - start < CFG.BOSS_SPAWN_WINDOW_MS) {
        const poll = inBossWindow(now) ? CFG.BOSS_WINDOW_POLL_MS : CFG.IDLE_POLL_MS; // 3 phút đầu giờ quét dày hơn
        for (let w = 0; w < poll && c.alive(); w += 1000) await this.sleep(Math.min(1000, poll - w));
        return 'LOAD';
      }
      const next = start + H;
      this.log(`Quá ${CFG.BOSS_SPAWN_WINDOW_MS / 60000} phút đầu giờ mà không có boss, nghỉ quét tới ${new Date(next).toLocaleTimeString()} (đầu giờ sau).`);
      while (c.alive() && this.now() < next) await this.sleep(Math.min(1000, Math.max(0, next - this.now())));
      c.idleLogged = false;
      return 'LOAD';
    }

    async sEnter(c) {
      const { boss } = c;
      await this.skillGate(); // giữa hai trận boss: đổi chiêu đang chờ trước khi vào
      this.log(`Vào đánh ${SIZE_NAME[boss.size]} "${boss.name}" (${boss.element}) #${boss.id}`);
      c.mp = null; c.vit = { hp: null, hpMax: null }; c.warnedHeal = false; c.swapDone = false;
      this.coord.boss = true;
      // biết MP và HP ngay từ đầu (nếu lấy được) để đòn đầu không bị gửi khi đã hết MP / đang sắp chết
      if (this.api.getMe) {
        try {
          const me = await this.api.getMe();
          if (me && typeof me.mp === 'number') c.mp = me.mp;
          this.readVitals(c, me);
        } catch (_) {}
      }
      return 'YIELD';
    }

    // Đầu mỗi vòng: nhường săn yêu / tầm bảo đang giữa trận (tối đa vài chục giây)
    async sYield(c) {
      if (!c.alive()) return 'EXIT';
      // nhường trận săn yêu / tầm bảo / U Minh dở; trong 3 phút đầu giờ còn nhường cho đột phá (ưu tiên cao nhất)
      while ((this.coord.farm || this.coord.hunt || this.coord.umBattle || this.coord.towerBattle || (this.coord.bt && inBossWindow(this.now()))) && c.alive()) await this.sleep(500);
      if (!c.alive()) return 'EXIT';
      if (!this.isEnabled(c.boss)) return this.skipDisabled(c.boss);
      if (!c.swapDone) { c.swapDone = true; await this.swapSkills(c.boss.element, `boss ${SIZE_NAME[c.boss.size]} #${c.boss.id}`); if (!c.alive()) return 'EXIT'; } // đổi sang chiêu khắc trước đòn đầu
      return 'CHECK';
    }

    // kiểm tra boss còn sống (kể cả bị người khác hạ)
    async sCheck(c) {
      const { boss } = c;
      const r = await this.api.getBoss(boss.id), sp = r.spawn;
      if (!this.isEnabled(boss)) return this.skipDisabled(boss);
      if (sp.status !== 'active' || sp.hp <= 0) {
        this.log(`Boss #${boss.id} đã kết thúc (${sp.ended_reason || sp.status}). Dừng đánh boss này.`);
        return 'EXIT';
      }
      if (sp.expires_at && Date.parse(sp.expires_at) <= this.now()) { this.log('Boss hết hạn.'); return 'EXIT'; }
      const mode = this.st.modes[boss.size] || 'full';
      if (mode === 'min70' && BossCatalog.pct(sp) < BossCatalog.ENTRY_MIN) { // chế độ ≥70%: boss tụt dưới mốc (kể cả khi đang đánh) thì dừng đánh boss này
        this.st.logged.add(boss.id);
        this.log(`Boss #${boss.id} còn ${Math.round(BossCatalog.pct(sp) * 100)}% HP, thấp hơn ${BossCatalog.ENTRY_MIN * 100}% (chế độ của cỡ này): dừng đánh boss này.`);
        return 'EXIT';
      }
      if (BossCatalog.DMG[mode] && typeof r.myDamage !== 'number' && !this.st.logged.has('md' + boss.id)) { // không đọc được sát thương của bạn thì không thể tạm dừng: báo 1 lần
        this.st.logged.add('md' + boss.id);
        this.log(`Game không trả sát thương của bạn (myDamage) cho boss #${boss.id} nên chế độ "${mode === 'dmg50' ? '50%' : '25%'} · last hit" không tạm dừng được, đánh tới cùng.`);
      }
      if (BossCatalog.shouldPause(mode, sp, r.myDamage)) { // đủ sát thương: tạm dừng, nhả cờ để chế độ khác chạy, quét chờ mốc last hit
        this.st.paused.set(boss.id, this.now());
        this.log(`Sát thương của bạn lên boss #${boss.id} đã ${r.myDamage}/${sp.hp_max} (≥ ${BossCatalog.DMG[mode] * 100}% HP tối đa). Tạm dừng, chờ boss còn ≤ ${BossCatalog.LAST_HIT * 100}% HP (đang ${Math.round(BossCatalog.pct(sp) * 100)}%) rồi đánh tiếp.`);
        return 'EXIT';
      }
      if (this.st.paused.size && this.now() - (c.pScan || 0) >= 3000) { // đang chờ last hit boss khác: mỗi 3s xem nó đã tới mốc chưa, tới thì nhường
        c.pScan = this.now();
        const list = await this.api.getActive().catch(() => null), now = this.now();
        const ready = (list || []).find(b => b.id !== boss.id && this.st.paused.has(b.id) && this.st.enabled[b.size] && BossCatalog.active(b, now) && BossCatalog.pct(b) <= BossCatalog.LAST_HIT);
        if (ready) { this.log(`Boss #${ready.id} đã còn ${Math.round(BossCatalog.pct(ready) * 1000) / 10}% HP: chuyển sang đánh để giành last hit.`); return 'EXIT'; }
      }
      this.st.paused.delete(boss.id);
      c.sp = sp;
      return 'REFRESH';
    }

    // Bạn có thể đổi chiêu trong game bất cứ lúc nào: đọc lại bộ chiêu NGAY TRƯỚC khi đánh, nằm giữa 2 đòn.
    // Mốc đánh = đòn trước + BOSS_MIN_GAP_MS + jitter; đọc chiêu sớm hơn mốc đó BOSS_SKILL_REFRESH_LEAD_MS
    // (mặc định gap 5s, lead 1s: đánh xong 4s thì gọi API lấy chiêu, 1s sau đánh).
    async sRefresh(c) {
      c.jitter = this.limiter.pickJitter(this.rand); // giữ nguyên để sGap dùng đúng mốc này
      const due = this.limiter.last + this.minGapMs + c.jitter - CFG.BOSS_SKILL_REFRESH_LEAD_MS;
      while (c.alive() && this.now() < due) {
        if (!this.isEnabled(c.boss)) return this.skipDisabled(c.boss); // bỏ tích loại boss / bấm Tắt có tác dụng ngay
        await this.sleep(Math.min(1000, due - this.now()));
      }
      if (!c.alive()) return 'EXIT';
      await this.refreshSkills(c);
      return 'PILL';
    }

    // MP thấp -> dùng đan hồi MP (nếu bật)
    async sPill(c) {
      const pu = await this.pills.topUp(c.mp, c.vit.mpMax, c.alive, false);
      if (pu) { c.mp = pu.mp; c.vit.mpMax = pu.mpMax; if (pu.hp !== undefined) c.vit.hp = pu.hp; if (pu.hpMax > 0) c.vit.hpMax = pu.hpMax; }
      const hu = await this.hpPills.topUp(c.vit.hp, c.vit.hpMax, c.alive); // HP < x% → đan hồi HP tới y% (nếu bật)
      if (hu) { c.vit.hp = hu.hp; if (hu.hpMax > 0) c.vit.hpMax = hu.hpMax; if (typeof hu.mp === 'number') c.mp = hu.mp; if (hu.mpMax > 0) c.vit.mpMax = hu.mpMax; }
      if (!c.alive()) return 'EXIT';
      if (!this.isEnabled(c.boss)) return this.skipDisabled(c.boss);
      return 'CHOOSE';
    }

    // HP < 45% và có chiêu heal đủ MP -> đòn kế tiếp là heal; ngược lại chọn chiêu tấn công như thường
    async sChoose(c) {
      const { skills, vit, sp } = c;
      const viaPill = this.hpPills.covers(); // đan hồi HP lo việc hồi máu → không dùng chiêu heal
      const want = this.healCfg.update(this.hpKey, vit.hp, vit.hpMax, c); // mức hồi máu của chiêu heal (x% – y%) theo chế độ
      const heal = viaPill ? null : SkillSelector.pickHeal(skills, vit.hp, vit.hpMax, c.mp, want);
      if (!heal && !viaPill && (want === undefined ? SkillSelector.isLowHp(vit.hp, vit.hpMax) : want) && !c.warnedHeal) {
        c.warnedHeal = true;
        this.log(`HP thấp (${vit.hp}/${vit.hpMax}) nhưng ${SkillSelector.noHealReason(skills)}, tiếp tục đánh.`);
      }
      if (heal) c.warnedHeal = false;
      const act = heal || SkillSelector.pickAttack(skills, sp.element, c.mp);
      if (!act) {
        if (SkillSelector.noSkillCause(skills, sp.element, c.mp) === 'mp' && this.api.getMe) {
          const pu2 = await this.pills.topUp(c.mp, vit.mpMax, c.alive, true); // thiếu MP cho chiêu -> thử đan trước khi chờ
          if (pu2) { c.mp = pu2.mp; vit.mpMax = pu2.mpMax; return 'YIELD'; }
          return 'WAIT_MP';
        }
        await this.waitSkills(c); // không có chiêu tấn công nào: chờ rồi đọc lại chiêu + MP, không tắt
        return 'YIELD';
      }
      c.act = act;
      return 'GAP';
    }

    // Hết MP nhưng boss còn: cứ BOSS_MP_CHECK_MS kiểm tra lại, đủ MP cho 1 chiêu thì đánh tiếp.
    async sWaitMp(c) {
      const { boss } = c; const { st, api } = this;
      this.log(`Hết MP (còn ${c.mp}) nhưng boss #${boss.id} còn sống. Chờ MP hồi, kiểm tra lại mỗi ${CFG.BOSS_MP_CHECK_MS / 1000}s, đủ MP là đánh tiếp.`);
      let checks = 0;
      while (c.alive()) {
        // ngủ từng giây để bỏ tích loại boss hoặc bấm Tắt là có tác dụng ngay, không phải đợi hết chu kỳ 9s
        for (let w = 0; w < CFG.BOSS_MP_CHECK_MS && c.alive() && this.isEnabled(boss); w += 1000) await this.sleep(Math.min(1000, CFG.BOSS_MP_CHECK_MS - w));
        if (!c.alive()) return 'EXIT';
        if (!this.isEnabled(boss)) return this.skipDisabled(boss);
        let sp, me;
        try { sp = (await api.getBoss(boss.id)).spawn; me = await api.getMe(); st.errors = 0; }
        catch (e) {
          st.errors++;
          this.log(`Lỗi khi kiểm tra MP: ${e.message} (lần ${st.errors}, thử lại sau ${this.errWaitSec()}s)`);
          continue;
        }
        if (this.ended(sp)) {
          this.log(`Boss #${boss.id} đã kết thúc trong lúc chờ MP (${sp.ended_reason || sp.status}).`);
          return 'EXIT';
        }
        if (me && typeof me.mp === 'number') c.mp = me.mp;
        this.readVitals(c, me);
        await this.refreshSkills(c); // đổi chiêu trong lúc chờ MP cũng có hiệu lực ngay
        if (SkillSelector.pickAttack(c.skills, sp.element, c.mp)) { this.log(`MP đã hồi (${c.mp}), đánh tiếp boss #${boss.id}.`); return 'YIELD'; }
        if (++checks % 6 === 1) this.log(`MP ${c.mp}, chưa đủ cho chiêu nào, tiếp tục chờ...`);
      }
      return 'EXIT';
    }

    async sGap(c) {
      await this.waitGap(c.jitter);
      if (!c.alive()) return 'EXIT';
      // kiểm tra lần cuối, ngay trước khi gửi: waitGap có thể đã chờ vài giây
      if (!this.isEnabled(c.boss)) return this.skipDisabled(c.boss);
      return 'ATTACK';
    }

    async sAttack(c) {
      const { boss, act } = c; const { st, api } = this;
      this.markAttack();
      try {
        c.res = await api.attack(boss.id, { action: 'skill', skillId: act.skill.id });
        st.errors = 0; this.healer.done();
      } catch (e) {
        if (isInjuredError(e)) { st.errors = 0; return 'RECOVER'; } // trọng thương: không tính là lỗi
        st.errors++;
        this.log(`Lỗi đánh: ${e.message} (lần ${st.errors}, thử lại sau ${this.errWaitSec()}s)`);
        await sleepSlices(this.sleep, CFG.BOSS_ERROR_RETRY_MS, c.alive); // lỗi: chờ 10s
        return 'YIELD';
      }
      return 'RESOLVE';
    }

    // trọng thương: chờ 15s rồi thử lại; boss chết/hết hạn trong lúc chờ thì thôi
    async sRecover(c) {
      const { boss } = c; const { api } = this;
      const r = await this.healer.step(c.alive, () => !this.isEnabled(boss), async () => {
        try {
          const sp = (await api.getBoss(boss.id)).spawn;
          if (this.ended(sp)) {
            this.log(`Boss #${boss.id} đã kết thúc trong lúc dưỡng thương (${sp.ended_reason || sp.status}).`);
            return 'ended';
          }
        } catch (_) {}
        return null;
      });
      if (r === 'retry') return 'YIELD';
      if (r === 'cancel') return this.skipDisabled(boss);
      return 'EXIT';
    }

    async sResolve(c) {
      const { boss, act, vit } = c;
      const d = (c.res && c.res.data) || {};
      if (typeof d.playerMp === 'number') c.mp = d.playerMp;
      if (typeof d.playerHp === 'number') vit.hp = d.playerHp;
      else if (act.heal && this.api.getMe) { // phản hồi không có HP: đọc lại để biết đã hồi chưa, tránh heal lặp vô hạn
        try { const me = await this.api.getMe(); if (me && typeof me.hp === 'number') vit.hp = me.hp; if (me && me.hp_max > 0) vit.hpMax = me.hp_max; } catch (_) {}
      }
      const hits = CombatFormatter.sumHits(d.log, act.skill.name);
      const info = {
        name: act.skill.name, rel: act.rel, heal: !!act.heal, dealt: d.damageDealt ?? hits.dealt, foeHp: d.bossHp, foeMax: d.bossHpMax,
        taken: hits.taken, hp: vit.hp, hpMax: vit.hpMax, mp: d.playerMp ?? c.mp, mpMax: vit.mpMax,
      };
      this.log((act.heal ? '💚 ' : '') + CombatFormatter.fightLine(info));
      if (act.heal) return 'YIELD';
      if (d.bossDefeated) { this.log(`Boss #${boss.id} đã bị hạ.`); return 'EXIT'; }
      if (typeof d.playerHp === 'number' && d.playerHp <= 0) { // hết HP: rời trận, dưỡng thương, rồi quét lại boss
        this.log('Nhân vật hết HP: rời trận, dưỡng thương rồi quét lại boss.');
        this.coord.boss = false;
        await this.healer.step(c.alive);
        return 'EXIT';
      }
      return 'YIELD';
    }

    async sExit(c) {
      this.coord.boss = false; this.coord.btWake = true; // đánh boss xong: đột phá kiểm tra tu vi ngay
      return c.alive() ? 'LOAD' : null;
    }
  }
  BossEngine.TRANSITIONS = {
    LOAD: ['LOAD', 'PICK'], PICK: ['IDLE_WAIT', 'ENTER'], IDLE_WAIT: ['LOAD'], ENTER: ['YIELD'],
    YIELD: ['CHECK', 'EXIT'], CHECK: ['REFRESH', 'EXIT'], REFRESH: ['PILL', 'EXIT'], PILL: ['CHOOSE', 'EXIT'],
    CHOOSE: ['YIELD', 'WAIT_MP', 'GAP', 'EXIT'], WAIT_MP: ['YIELD', 'EXIT'], GAP: ['ATTACK', 'EXIT'],
    ATTACK: ['RESOLVE', 'RECOVER', 'YIELD', 'EXIT'], RECOVER: ['YIELD', 'EXIT'], RESOLVE: ['YIELD', 'EXIT'], EXIT: ['LOAD'],
  };

  /* ---------------------------------------------------------------------
   *  ĐỘT PHÁ
   *  FSM: CHECK → PREVIEW → ENGAGE → SLEEP → CHECK ...
   *  Khi tu vi (exp) >= exp_to_next thì đột phá. Thất bại mất một nửa tu vi nên chỉ chạy khi người dùng bật.
   *  Không đột phá nếu sẽ kích hoạt thiên kiếp. Chờ boss / tầm bảo / săn yêu đánh xong trận đang dở rồi mới đột phá.
   * --------------------------------------------------------------------- */
  /* Tăng tỉ lệ đột phá: đan (effect breakthrough_add, có hạn 10 phút) và công pháp (effect breakthrough_add) */
  class BreakthroughCatalog {
    static effects(x) {
      let e = x && x.effects;
      if (typeof e === 'string') { try { e = JSON.parse(e); } catch (_) { e = []; } }
      return Array.isArray(e) ? e : [];
    }
    static bonus(x) { return BreakthroughCatalog.effects(x).filter(e => e && e.type === 'breakthrough_add').reduce((n, e) => n + (Number(e.value) || 0), 0); }
    static key(it) { return it.item_id != null ? it.item_id : it.name; }
    static pct(b) { return `${Math.round(b * 1000) / 10}%`.replace('.', ','); }
    // vật phẩm dùng được (is_consumable = 1 / true / "1"); thiếu trường hoặc 0 thì không (vd. giày có hiệu ứng đột phá nhưng là đồ trang bị)
    static consumable(it) { const v = it && it.is_consumable; return v === 1 || v === true || v === '1'; }
    // đan tăng tỉ lệ đột phá trong túi (phải là vật phẩm dùng được), gộp theo loại, mạnh nhất trước
    static pills(inv) {
      const m = new Map();
      for (const it of Array.isArray(inv) ? inv : []) {
        const b = BreakthroughCatalog.bonus(it), q = Number(it.quantity) || 0;
        if (!(b > 0) || q <= 0 || !BreakthroughCatalog.consumable(it)) continue;
        const k = BreakthroughCatalog.key(it), cur = m.get(k);
        if (cur) cur.quantity += q; else m.set(k, { ...it, quantity: q, bonus: b });
      }
      return [...m.values()].sort((a, b) => (b.bonus - a.bonus) || String(a.name).localeCompare(String(b.name), 'vi'));
    }
    static pillLabel(it) { return `${it.name} (+${BreakthroughCatalog.pct(it.bonus)}) ×${it.quantity.toLocaleString('en-US')}`; }
    static bestTechnique(list) {
      let best = null;
      for (const t of Array.isArray(list) ? list : []) { if (t && t.can_activate === false) continue; const b = BreakthroughCatalog.bonus(t); if (b > 0 && (!best || b > best.bonus)) best = { id: t.id, name: t.name, bonus: b }; }
      return best;
    }
    static hasBuff(me, nowMs) { return !!me && (me.active_buffs || []).some(b => b && b.type === 'breakthrough_add' && (!b.expires_at || Date.parse(b.expires_at) > nowMs)); }
  }

  class BreakthroughEngine extends Engine {
    constructor(deps) {
      super(deps);
      Object.assign(this.st, { attempts: 0, wins: 0, warnedTribulation: false, pillOn: false, pillId: null, pendingTech: null });
      this.machine = this.track(new StateMachine('breakthrough', {
        CHECK: c => this.sCheck(c), PREVIEW: c => this.sPreview(c), ENGAGE: c => this.sEngage(c), SLEEP: c => this.sSleep(c),
      }, BreakthroughEngine.TRANSITIONS));
    }
    get startMessage() { return `BẮT ĐẦU tự động đột phá (kiểm tra tu vi mỗi ${CFG.BT_POLL_MS / 1000}s).`; }
    get stopMessage() { return 'ĐÃ DỪNG tự động đột phá.'; }
    releaseFlags() { this.coord.bt = false; this.coord.btPause = false; }
    execute(alive) { return this.machine.run('CHECK', { alive, me: null, pv: null }); }

    pct(c) { return `${Math.round(c * 1000) / 10}%`.replace('.', ','); }
    rest(ms) { this.st.errors = 0; this.st.waitMs = ms || CFG.BT_POLL_MS; return 'SLEEP'; } // hết một lượt kiểm tra thành công (chờ ms rồi kiểm tra lại)
    fail(e) {
      const { st } = this;
      st.errors++; st.waitMs = CFG.BT_ERROR_RETRY_MS; st.failed = true;
      this.log(`Lỗi đột phá: ${e.message} (lần ${st.errors}, thử lại sau ${CFG.BT_ERROR_RETRY_MS / 1000}s)`);
      return 'SLEEP';
    }

    // Đổi lại công pháp cũ (st.pendingTech) sau đột phá, thắng hay thua. Làm lại được nhiều lần; chưa xong thì giữ pendingTech để lần sau làm tiếp.
    async restoreTechnique() {
      const { st, api } = this;
      if (!st.pendingTech || !api.activateTechnique) return;
      const want = st.pendingTech;
      for (let i = 0; i < CFG.BT_RESTORE_TRIES; i++) {
        try {
          const me = api.getMe ? await api.getMe() : null;
          if (!me || me.technique_id !== want) await api.activateTechnique(want);
          st.pendingTech = null; this.emit('techpending', null);
          this.log('Đã đổi lại công pháp cũ.');
          return;
        } catch (e) { this.log(`Lỗi đổi lại công pháp (${e.message}), thử lại...`); await this.sleep(Math.min(10000, 2000 * (i + 1))); }
      }
      this.log('Chưa đổi lại được công pháp cũ, sẽ thử lại ở lần kiểm tra kế tiếp.');
    }

    // Tỉ lệ < 100%: đổi sang công pháp có breakthrough_add cao nhất (tự động) và dùng 1 đan tăng tỉ lệ (nếu bật, chưa có buff). Lỗi thì ghi log rồi vẫn đột phá.
    async boost(c) {
      const { st, api } = this; const B = BreakthroughCatalog;
      try {
        if (api.getKnownTechniques && api.activateTechnique) {
          const best = B.bestTechnique(await api.getKnownTechniques()), cur = c.me && c.me.technique_id;
          if (!best) this.log('Chưa có công pháp nào tăng tỉ lệ đột phá, giữ công pháp hiện tại.');
          else if (best.id === cur) this.log(`Đang dùng công pháp tốt nhất cho đột phá: ${best.name} (+${B.pct(best.bonus)}).`);
          else if (!cur) this.log('Không biết công pháp hiện tại nên không đổi (không đổi lại được).');
          else {
            st.pendingTech = cur; this.emit('techpending', cur);
            await api.activateTechnique(best.id);
            this.log(`Đổi công pháp ${cur} → ${best.name} (+${B.pct(best.bonus)} đột phá), sau đột phá sẽ đổi lại.`);
          }
        }
      } catch (e) { this.log(`Không đổi được công pháp: ${e.message}, vẫn đột phá.`); }
      try {
        if (st.pillOn && st.pillId != null && api.getInventory && api.useItem) {
          let me = c.me; try { me = await api.getMe(); } catch (_) {}
          if (B.hasBuff(me, this.now())) this.log('Đã có đan tăng đột phá còn hiệu lực, không dùng thêm.');
          else {
            const p = B.pills(await api.getInventory(0)).find(x => B.key(x) === st.pillId);
            if (!p) this.log('Hết đan tăng đột phá đã chọn, đột phá không dùng đan.');
            else { await api.useItem(p.id, 1, 0); this.log(`Dùng 1 ${p.name} (+${B.pct(p.bonus)} đột phá).`); }
          }
        }
      } catch (e) { this.log(`Không dùng được đan tăng đột phá: ${e.message}, vẫn đột phá.`); }
      try { const pv = await api.breakthroughPreview(); if (pv && typeof pv.chance === 'number') this.log(`Tỉ lệ thành công sau khi tăng: ${this.pct(pv.chance)}.`); } catch (_) {}
    }

    async sCheck(c) {
      if (!c.alive()) return null;
      if (this.st.pendingTech) { try { await this.restoreTechnique(); } catch (_) {} }
      try {
        const me = await this.api.getMe();
        if (!me || typeof me.exp !== 'number' || !(me.exp_to_next > 0) || me.exp < me.exp_to_next) {
          this.st.warnedTribulation = false;
          const near = me && typeof me.exp === 'number' && me.exp_to_next > 0 && me.exp >= CFG.BT_NEAR_RATIO * me.exp_to_next; // gần đủ: quét dày
          return this.rest(near ? CFG.BT_NEAR_POLL_MS : CFG.BT_POLL_MS);
        }
        c.me = me;
        return 'PREVIEW';
      } catch (e) { return this.fail(e); }
    }

    async sPreview(c) {
      const { st } = this; const me = c.me;
      try {
        const pv = await this.api.breakthroughPreview();
        if (pv && pv.willTriggerTribulation && !st.warnedTribulation) { st.warnedTribulation = true; this.log(`Lần đột phá lên ${pv.targetRealmName} cấp ${pv.targetLevel} sẽ kích hoạt thiên kiếp, vẫn đột phá theo cài đặt.`); }
        this.log(`Đủ tu vi (${me.exp}/${me.exp_to_next}) → đột phá lên ${pv ? `${pv.targetRealmName} cấp ${pv.targetLevel}` : '?'}, tỉ lệ thành công ${pv && typeof pv.chance === 'number' ? this.pct(pv.chance) : '?'}.`);
        c.pv = pv;
        return 'ENGAGE';
      } catch (e) { return this.fail(e); }
    }

    async sEngage(c) {
      const { st, coord } = this;
      coord.bt = true; // farm / săn yêu thôi mở trận mới
      if (!coord.btPause) { coord.btPause = true; coord.btPauseSince = this.now(); } // các chế độ đang đánh dừng trước đòn kế tiếp
      let failed = false;
      try {
        const t0 = this.now();
        const busy = () => (this.bossWindow ? coord.farm || coord.hunt || coord.umBattle || coord.towerBattle : coord.fighting);
        if (coord.fighting) await this.sleep(CFG.BT_SETTLE_MS); // đòn đang gửi dở xong rồi mới đột phá
        if (!c.alive()) return null;
        if (c.pv && typeof c.pv.chance === 'number') {
          if (c.pv.chance < 1 - 1e-9) await this.boost(c);
          else this.log('Tỉ lệ đã 100%: đột phá luôn, không dùng đan / đổi công pháp.');
        }
        let d;
        try { d = await this.api.breakthrough(); }
        catch (e) {
          if (!busy()) throw e;
          // server không cho đột phá khi đang trong trận: thả các chế độ kia đánh tiếp, đột phá ngay khi trận kết thúc
          this.log(`Chưa đột phá được khi đang trong trận (${e.message}), sẽ đột phá ngay khi trận kết thúc.`);
          coord.btPause = false;
          while (busy() && c.alive() && this.now() - t0 < CFG.BT_IDLE_WAIT_MS) await this.sleep(500);
          if (!c.alive()) return null;
          if (busy()) { this.log('Đang bận đánh, chưa đột phá được, thử lại sau.'); st.waitMs = CFG.BT_ERROR_RETRY_MS; return 'SLEEP'; }
          d = await this.api.breakthrough();
        }
        st.attempts++; st.failed = false;
        const msgs = (d && d.messages || []).join(' ');
        if (d && d.success) { st.wins++; this.log(`Đột phá THÀNH CÔNG${d.chance != null ? ` (${this.pct(d.chance)})` : ''}! ${msgs}`); }
        else this.log(`Đột phá THẤT BẠI${d && d.chance != null ? ` (${this.pct(d.chance)})` : ''}. ${msgs}`);
        return this.rest();
      } catch (e) { failed = true; return this.fail(e); }
      finally {
        try { await this.restoreTechnique(); } catch (_) {} // thắng hay thua đều đổi lại công pháp cũ trước khi nhả cờ
        this.emit('attempt');
        coord.bt = false;
        // đang lỗi: giữ các chế độ khác dừng thêm cho tới khi thử lại (tối đa BT_HOLD_MAX_MS), còn lại nhả ngay
        if (!(failed && this.now() - coord.btPauseSince < CFG.BT_HOLD_MAX_MS)) coord.btPause = false;
      }
    }

    async sSleep(c) {
      const ms = this.st.waitMs || CFG.BT_POLL_MS; this.st.waitMs = 0;
      for (let w = 0; w < ms && c.alive() && !this.coord.btWake; w += 1000) await this.sleep(Math.min(1000, ms - w));
      this.coord.btWake = false; // việc vừa xong (đánh boss...): kiểm tra tu vi ngay
      return 'CHECK';
    }
  }
  BreakthroughEngine.TRANSITIONS = { CHECK: ['PREVIEW', 'SLEEP'], PREVIEW: ['ENGAGE', 'SLEEP'], ENGAGE: ['SLEEP'], SLEEP: ['CHECK'] };

  /* ---------------------------------------------------------------------
   *  LUYỆN ĐAN
   *  FSM: LOAD → BULK → DECIDE → (CRAFT → (WAIT | COOL) | WAIT) → LOAD ...
   *   - LOAD   : đọc trạng thái luyện đan + túi đồ, tìm đan phương đang chọn, đếm số viên đan đang có
   *   - BULK   : với mỗi loại đan (loại chính + các loại thêm bằng nút +) đang bật công tắc "đủ 50 lượt": maxTimes ≥ 50 thì luyện 50 lượt,
   *              nghỉ ALCHEMY_BULK_GAP_MS rồi kiểm tra lại (LOAD) cho tới khi không loại nào đủ 50 lượt nữa → DECIDE
   *   - DECIDE : số viên = 0 → CRAFT; số viên > 0 → WAIT
   *   - CRAFT  : luyện min(ALCHEMY_MAX_TIMES, maxTimes) lượt; còn đan sau khi luyện → WAIT, vẫn 0 (thất bại hết) → COOL
   *   - WAIT   : chờ ALCHEMY_POLL_MS (5 phút) rồi kiểm tra lại; đổi đan phương hoặc bấm Tắt là thoát ngay
   *   - COOL   : nghỉ ngắn rồi kiểm tra lại
   *  Không đụng tới trận chiến nên không dùng Coordinator.
   * --------------------------------------------------------------------- */
  class AlchemyEngine extends Engine {
    constructor(deps) {
      super(deps);
      Object.assign(this.st, { recipeId: null, crafts: 0, lastOwned: null, bulkExtras: [], bulkOn: {}, bulkVer: 0 });
      this.machine = this.track(new StateMachine('alchemy', {
        LOAD: c => this.sLoad(c), BULK: c => this.sBulk(c), DECIDE: c => this.sDecide(c), CRAFT: c => this.sCraft(c),
        WAIT: c => this.sWait(c), COOL: c => this.sCool(c),
      }, AlchemyEngine.TRANSITIONS));
    }
    get startMessage() { return 'BẮT ĐẦU tự động luyện đan.'; }
    get stopMessage() { return 'ĐÃ DỪNG tự động luyện đan.'; }
    execute(alive) { return this.machine.run('LOAD', { alive, recipe: null, owned: 0, waitLogged: false, state: null, warned: new Set() }); }

    fail(e, label) {
      const { st } = this;
      st.errors++;
      this.log(`Lỗi ${label}: ${e.message} (lần ${st.errors}, thử lại sau ${this.errWaitSec()}s)`);
      return 'WAIT_ERR';
    }

    async sLoad(c) {
      if (!c.alive()) return null;
      const { st, api } = this;
      await this.yieldToBossFight(c.alive, 'luyện đan');
      if (!c.alive()) return null;
      if (st.recipeId == null) { await this.waitConfig(c.alive, 'Chưa chọn loại đan để luyện'); return 'LOAD'; }
      try {
        const [state, inv] = await Promise.all([api.getAlchemyState(), api.getInventory()]);
        const recipe = ((state && state.recipes) || []).find(r => r.id === st.recipeId);
        if (!recipe) { await this.waitConfig(c.alive, `Không tìm thấy đan phương #${st.recipeId}`); return 'LOAD'; }
        if (!AlchemyCatalog.craftable([recipe]).length) { await this.waitConfig(c.alive, `Đan phương "${recipe.name}" chưa học hoặc đang bị khóa`); return 'LOAD'; }
        c.recipe = recipe; c.state = state; c.owned = st.lastOwned = AlchemyCatalog.owned(inv, recipe);
        st.errors = 0;
        return 'BULK';
      } catch (e) {
        const next = this.fail(e, 'đọc trạng thái luyện đan');
        if (!next) return null;
        await sleepSlices(this.sleep, this.errWaitMs(), c.alive);
        return 'LOAD';
      }
    }

    // các loại đan đang bật "đủ 50 lượt": loại chính trước, rồi các loại thêm theo thứ tự trong danh sách
    bulkIds() {
      const { st } = this; const ids = [];
      for (const id of [st.recipeId, ...st.bulkExtras]) if (id != null && st.bulkOn[id] && !ids.includes(id)) ids.push(id);
      return ids;
    }

    async sBulk(c) {
      const { st, api } = this;
      let did = false;
      for (const id of this.bulkIds()) {
        if (!c.alive()) return null;
        const r = ((c.state && c.state.recipes) || []).find(x => x.id === id);
        if (!r || !AlchemyCatalog.craftable([r]).length) {
          if (!c.warned.has(id)) { c.warned.add(id); this.log(`Luyện đủ ${CFG.ALCHEMY_MAX_TIMES} lượt: đan phương #${id} chưa học / bị khóa / không còn, bỏ qua.`); }
          continue;
        }
        if (!(typeof r.maxTimes === 'number' && r.maxTimes >= CFG.ALCHEMY_MAX_TIMES)) continue;
        await this.yieldToBossFight(c.alive, 'luyện đan');
        if (!c.alive()) return null;
        try {
          const d = await api.alchemyCraft(r.id, CFG.ALCHEMY_MAX_TIMES);
          st.errors = 0; st.crafts++; did = true;
          this.log(`[đủ ${CFG.ALCHEMY_MAX_TIMES} lượt] ${d && d.message ? d.message : `Đã luyện ${CFG.ALCHEMY_MAX_TIMES} lượt ${r.result_name || r.name}.`}`);
        } catch (e) {
          const next = this.fail(e, `luyện đan ${r.result_name || r.name}`);
          if (!next) return null;
          await sleepSlices(this.sleep, this.errWaitMs(), c.alive);
          return 'LOAD';
        }
        await sleepSlices(this.sleep, CFG.ALCHEMY_BULK_GAP_MS, c.alive);
      }
      return did ? 'LOAD' : 'DECIDE'; // vừa luyện thì đọc lại nguyên liệu; không luyện gì thì sang luật "hết đan mới luyện"
    }

    async sDecide(c) {
      if (c.owned > 0) {
        if (!c.waitLogged) this.log(`Còn ${c.owned} ${c.recipe.result_name}, chờ ${CFG.ALCHEMY_POLL_MS / 60000} phút rồi kiểm tra lại (luyện tiếp khi hết).`);
        c.waitLogged = true;
        return 'WAIT';
      }
      c.waitLogged = false;
      return 'CRAFT';
    }

    async sCraft(c) {
      const { st, api } = this; const r = c.recipe;
      const times = AlchemyCatalog.batchTimes(r, CFG.ALCHEMY_MAX_TIMES);
      if (times <= 0) {
        this.log(`Hết ${r.result_name} nhưng không đủ nguyên liệu để luyện, chờ ${CFG.ALCHEMY_POLL_MS / 60000} phút rồi kiểm tra lại.`);
        c.waitLogged = true; // đã báo, tránh báo lặp "Còn N viên"
        return 'WAIT';
      }
      await this.yieldToBossFight(c.alive, 'luyện đan');
      if (!c.alive()) return null;
      try {
        const d = await api.alchemyCraft(r.id, times);
        st.errors = 0; st.crafts++;
        this.log(d && d.message ? d.message : `Đã luyện ${times} lượt ${r.result_name}.`);
        const owned = Array.isArray(d && d.inventory) ? AlchemyCatalog.owned(d.inventory, r) : null;
        if (owned == null) return 'LOAD'; // phản hồi không kèm túi đồ: đọc lại cho chắc
        c.owned = st.lastOwned = owned;
        if (owned > 0) { c.waitLogged = false; return 'DECIDE'; }
        this.log(`Luyện xong nhưng chưa nhận được viên ${r.result_name} nào (thất bại hết), luyện lại sau ${CFG.ALCHEMY_CRAFT_GAP_MS / 1000}s.`);
        return 'COOL';
      } catch (e) {
        const next = this.fail(e, 'luyện đan');
        if (!next) return null;
        await sleepSlices(this.sleep, this.errWaitMs(), c.alive);
        return 'LOAD';
      }
    }

    async sWait(c) {
      const id = this.st.recipeId, ver = this.st.bulkVer;
      await sleepSlices(this.sleep, CFG.ALCHEMY_POLL_MS, () => c.alive() && this.st.recipeId === id && this.st.bulkVer === ver); // đổi đan phương / công tắc 50 lượt → kiểm tra ngay
      c.waitLogged = false;
      return 'LOAD';
    }

    async sCool(c) {
      await sleepSlices(this.sleep, CFG.ALCHEMY_CRAFT_GAP_MS, c.alive);
      return 'LOAD';
    }
  }
  AlchemyEngine.TRANSITIONS = { LOAD: ['LOAD', 'BULK'], BULK: ['LOAD', 'DECIDE'], DECIDE: ['WAIT', 'CRAFT'], CRAFT: ['DECIDE', 'WAIT', 'COOL', 'LOAD'], WAIT: ['LOAD'], COOL: ['LOAD'] };

  /* ---------------------------------------------------------------------
   *  YÊU THÚ: mở Thú Đản (trứng) + phóng sinh theo bộ lọc
   *  BeastCatalog (domain): nhận diện trứng, bộ lọc độ hiếm / sao, quy tắc bảo vệ
   *  BeastEngine FSM (chế độ tự động): LOAD → RELEASE → HATCH → (LOAD | WAIT) → LOAD ...
   *   - LOAD    : đọc danh sách thú + túi đồ (đếm trứng, số thú)
   *   - RELEASE : phóng sinh các con khớp bộ lọc để có chỗ trống. Chế độ tự động KHÔNG BAO GIỜ phóng sinh Sử thi / Huyền thoại
   *   - HATCH   : mở min(số trứng, BEAST_HATCH_MAX, chỗ trống) trứng; còn trứng thì quay LOAD (lại phóng sinh rồi mở tiếp)
   *   - WAIT    : hết trứng / Yêu Thú Các đầy mà không phóng sinh được → chờ BEAST_POLL_MS; đổi bộ lọc là kiểm tra ngay
   *  Nút tay (manualHatch / manualRelease) dùng chung khóa tuần tự với vòng tự động để không gọi API chồng nhau.
   *  Luôn bỏ qua: con đang xuất chiến, con đã lên cấp (level > 1), con từ `keep` sao trở lên (keep = 0: không giữ).
   * --------------------------------------------------------------------- */
  class BeastCatalog {
    static isEgg(it) { return !!it && (it.effect_type === 'beast_egg' || it.name === 'Thú Đản'); }
    static eggs(inv) { return (inv || []).filter(it => BeastCatalog.isEgg(it) && (Number(it.quantity) || 0) > 0); }
    static eggCount(inv) { return BeastCatalog.eggs(inv).reduce((n, it) => n + (Number(it.quantity) || 0), 0); }
    static defaultFilter() { return { rar: { thuong: false, hiem: false, su_thi: false, huyen_thoai: false }, keep: 0 }; }
    static normalize(f) {
      const d = BeastCatalog.defaultFilter();
      if (f && f.rar) for (const k of BeastCatalog.KEYS) d.rar[k] = f.rar[k] === true;
      const keep = Number(f && f.keep); d.keep = Number.isInteger(keep) && keep >= 1 && keep <= 5 ? keep : 0;
      return d;
    }
    // lý do KHÔNG được phóng sinh ('' = được)
    static protectedReason(b, filter) {
      if (b.isActive !== false) return 'đang xuất chiến';
      if ((Number(b.level) || 0) !== 1) return 'đã lên cấp';
      if (filter.keep > 0 && (Number(b.starRating) || 0) >= filter.keep) return `giữ lại từ ${filter.keep}★`;
      return '';
    }
    static releasable(beasts, filter, allowHigh) {
      return (beasts || []).filter(b => filter.rar[b.rarity] === true && (allowHigh || !BeastCatalog.HIGH.includes(b.rarity)) && !BeastCatalog.protectedReason(b, filter));
    }
    static label(b) { return `${b.name} (${BeastCatalog.LABEL[b.rarity] || b.rarity} · ${b.starRating}★ · Lv${b.level})`; }
  }
  BeastCatalog.KEYS = ['thuong', 'hiem', 'su_thi', 'huyen_thoai'];
  BeastCatalog.HIGH = ['su_thi', 'huyen_thoai'];
  BeastCatalog.LABEL = { thuong: 'Thường', hiem: 'Hiếm', su_thi: 'Sử thi', huyen_thoai: 'Huyền thoại' };

  class BeastEngine extends Engine {
    constructor(deps) {
      super(deps);
      Object.assign(this.st, { filter: BeastCatalog.defaultFilter(), ver: 0 });
      this.lock = Promise.resolve();
      this.machine = this.track(new StateMachine('beast', {
        LOAD: c => this.sLoad(c), RELEASE: c => this.sRelease(c), HATCH: c => this.sHatch(c), WAIT: c => this.sWait(c),
      }, BeastEngine.TRANSITIONS));
    }
    get startMessage() { return 'BẮT ĐẦU tự động mở trứng + phóng sinh yêu thú.'; }
    get stopMessage() { return 'ĐÃ DỪNG tự động yêu thú.'; }
    execute(alive) { return this.machine.run('LOAD', { alive, beasts: [], inv: [], warnedFull: false, waitLogged: false }); }
    serial(fn) { const p = this.lock.then(() => fn()); this.lock = p.catch(() => {}); return p; }
    fail(e, label) {
      const { st } = this;
      st.errors++;
      this.log(`Lỗi ${label}: ${e.message} (lần ${st.errors}, thử lại sau ${this.errWaitSec()}s)`);
      return 'WAIT_ERR';
    }
    async snapshot() {
      const [beasts, inv] = await Promise.all([this.api.getBeasts(), this.api.getInventory()]);
      const b = Array.isArray(beasts) ? beasts : [];
      this.emit('info', { eggs: BeastCatalog.eggCount(inv), count: b.length });
      return { beasts: b, inv: Array.isArray(inv) ? inv : [] };
    }
    // Phóng sinh từng con: xem trước để kiểm tra lại (không xuất chiến / Lv1 / đúng độ hiếm) rồi mới xóa. Trả mảng id đã phóng sinh.
    async releaseList(list, alive) {
      const done = [];
      for (const b of list) {
        if (alive && !alive()) break;
        const pv = await this.api.beastReleasePreview(b.id);
        if (!pv || pv.isActive !== false || Number(pv.level) !== 1 || pv.rarity !== b.rarity) { this.log(`Bỏ qua ${BeastCatalog.label(b)}: trạng thái đã đổi (xuất chiến / lên cấp / khác độ hiếm).`); continue; }
        const d = await this.api.releaseBeast(b.id);
        done.push(b.id);
        this.log(`Đã phóng sinh ${BeastCatalog.label(b)}${d && d.refundQty ? `, nhận ${d.refundQty} ${d.refundItemName || ''}` : ''}.`);
        await this.sleep(CFG.BEAST_CALL_GAP_MS);
      }
      return done;
    }
    // Mở 1 lô trứng. Trả { n, hatched, inv } ; n = 0 nghĩa là không mở được (hết trứng / đầy).
    async hatchBatch(inv, count) {
      const eggs = BeastCatalog.eggs(inv), room = Math.max(0, CFG.BEAST_CAP - count);
      if (!eggs.length || room <= 0) return { n: 0, hatched: [], inv, room };
      const n = Math.min(Number(eggs[0].quantity) || 0, CFG.BEAST_HATCH_MAX, room);
      const d = await this.api.useItem(eggs[0].id, n);
      const hatched = (d && d.beastsHatched) || [];
      this.log(`Đã mở ${n} trứng: ${hatched.length ? hatched.map(h => `${h.name} (${BeastCatalog.LABEL[h.rarity] || h.rarity} · ${h.star}★)`).join(', ') : '(không có thông tin thú nở)'}.`);
      return { n, hatched, inv: Array.isArray(d && d.inventory) ? d.inventory : null, room };
    }

    /* ----- nút tay ----- */
    async manualCandidates() { const s = await this.snapshot(); return BeastCatalog.releasable(s.beasts, this.st.filter, true); }
    manualRelease(list) { return this.serial(async () => { const ids = await this.releaseList(list, null); await this.snapshot().catch(() => {}); return ids; }); }
    manualHatch() {
      return this.serial(async () => {
        let total = 0;
        for (let i = 0; i < 100; i++) {
          let s = await this.snapshot();
          if (!BeastCatalog.eggCount(s.inv)) { this.log(total ? `Đã mở xong ${total} trứng.` : 'Không có Thú Đản nào để mở.'); break; }
          if (s.beasts.length >= CFG.BEAST_CAP) { this.log(`Yêu Thú Các đã đầy (${s.beasts.length}/${CFG.BEAST_CAP}); hãy phóng sinh bớt rồi mở tiếp.${total ? ` Đã mở ${total} trứng.` : ''}`); break; }
          const r = await this.hatchBatch(s.inv, s.beasts.length);
          if (!r.n) break;
          total += r.n; await this.sleep(CFG.BEAST_CALL_GAP_MS);
        }
        await this.snapshot().catch(() => {});
        return total;
      });
    }

    /* ----- vòng tự động ----- */
    async sLoad(c) {
      if (!c.alive()) return null;
      await this.yieldToBossFight(c.alive, 'yêu thú');
      if (!c.alive()) return null;
      try { const s = await this.snapshot(); c.beasts = s.beasts; c.inv = s.inv; this.st.errors = 0; return 'RELEASE'; }
      catch (e) {
        const next = this.fail(e, 'đọc yêu thú'); if (!next) return null;
        await sleepSlices(this.sleep, this.errWaitMs(), c.alive); return 'LOAD';
      }
    }
    async sRelease(c) {
      const list = BeastCatalog.releasable(c.beasts, this.st.filter, false); // tự động: không bao giờ đụng Sử thi / Huyền thoại
      if (!list.length) return 'HATCH';
      await this.yieldToBossFight(c.alive, 'yêu thú');
      if (!c.alive()) return null;
      try {
        this.log(`Phóng sinh ${list.length} con khớp bộ lọc...`);
        const ids = await this.serial(() => this.releaseList(list, c.alive));
        c.beasts = c.beasts.filter(b => !ids.includes(b.id));
        this.emit('info', { eggs: BeastCatalog.eggCount(c.inv), count: c.beasts.length });
        this.st.errors = 0; return 'HATCH';
      } catch (e) {
        const next = this.fail(e, 'phóng sinh'); if (!next) return null;
        await sleepSlices(this.sleep, this.errWaitMs(), c.alive); return 'LOAD';
      }
    }
    async sHatch(c) {
      if (!BeastCatalog.eggCount(c.inv)) return 'WAIT';
      if (c.beasts.length >= CFG.BEAST_CAP) {
        if (!c.warnedFull) this.log(`Yêu Thú Các đầy (${c.beasts.length}/${CFG.BEAST_CAP}) và không còn con nào phóng sinh được theo bộ lọc nên chưa mở trứng.`);
        c.warnedFull = true; return 'WAIT';
      }
      c.warnedFull = false;
      await this.yieldToBossFight(c.alive, 'yêu thú');
      if (!c.alive()) return null;
      try {
        const r = await this.serial(() => this.hatchBatch(c.inv, c.beasts.length));
        this.st.errors = 0;
        if (!r.n) return 'WAIT';
        await sleepSlices(this.sleep, CFG.BEAST_CALL_GAP_MS, c.alive);
        return 'LOAD';
      } catch (e) {
        const next = this.fail(e, 'mở trứng'); if (!next) return null;
        await sleepSlices(this.sleep, this.errWaitMs(), c.alive); return 'LOAD';
      }
    }
    async sWait(c) {
      const ver = this.st.ver;
      this.log(`Xong. Kiểm tra lại sau ${CFG.BEAST_POLL_MS / 60000} phút (đổi bộ lọc hoặc bấm nút là chạy ngay).`);
      await sleepSlices(this.sleep, CFG.BEAST_POLL_MS, () => c.alive() && this.st.ver === ver);
      return 'LOAD';
    }
  }
  BeastEngine.TRANSITIONS = { LOAD: ['LOAD', 'RELEASE'], RELEASE: ['HATCH', 'LOAD'], HATCH: ['WAIT', 'LOAD'], WAIT: ['LOAD'] };

  /* ---------------------------------------------------------------------
   *  ENGINE ĐÁNH THEO TRẬN (dùng chung cho tầm bảo và săn yêu)
   *  Hai chế độ có cùng dạng phản hồi (match / character / roundLog / finished / rewards),
   *  chỉ khác API (doAction), cách vào trận và cách xử lý trận không thắng (onNonWin).
   *
   *  FSM trận đánh (battle): PILL → CHOOSE → GAP → ACT → RESOLVE → PILL ...   (nhánh phụ: RECOVER khi trọng thương)
   * --------------------------------------------------------------------- */
  class MatchEngine extends Engine {
    constructor(deps) {
      super(deps);
      Object.assign(this.st, { zone: DEFAULT_ZONE, monsterId: null, kills: 0, mp: null, mpMax: null, hp: null, hpMax: null, realm: null, tickets: null });
      this.healer = this.attach(new Healer(deps));
      this.pills = this.attach(new PillManager(deps, this.hpKey));
      this.hpPills = this.attach(new HpPillService(deps, this.hpKey));
      this.healCfg = deps.healCfg || new HealSkillConfig();
      this.healer.assist = (hp, hpMax, alive) => this.hpPills.topUp(hp, hpMax, alive);
      this.gate = deps.mpGate || new MpGate();
      this.hpGate = deps.hpGate || new HpGate();
      this.battle = this.track(new StateMachine('battle', {
        PILL: c => this.bPill(c), CHOOSE: c => this.bChoose(c), GAP: c => this.bGap(c),
        ACT: c => this.bAct(c), RECOVER: c => this.bRecover(c), RESOLVE: c => this.bResolve(c),
      }, MatchEngine.BATTLE_TRANSITIONS));
    }
    get hpKey() { return ''; } // lớp con khai báo: farm | hunt | um
    get minGapMs() { return CFG.MATCH_MIN_GAP_MS; } // tầm bảo và săn yêu dùng chung
    get modeName() { return ''; }
    doAction(/* body */) { throw new Error('doAction() chưa được cài đặt'); }

    setTickets(n) { this.st.tickets = n; this.emit('tickets', n); }

    /* --- theo dõi MP --- */
    pct() { const { mp, mpMax } = this.st; return typeof mp === 'number' && mpMax > 0 ? mp / mpMax : null; }
    pctText() { const p = this.pct(); const { mp, mpMax } = this.st; return p == null ? `${mp}` : `${mp}/${mpMax} = ${Math.round(p * 100)}%`; }
    async refreshMe() {
      const me = await this.api.getMe();
      const { st } = this;
      if (me && typeof me.mp === 'number') st.mp = me.mp;
      if (me && typeof me.mp_max === 'number') st.mpMax = me.mp_max;
      if (me && typeof me.hp === 'number') st.hp = me.hp;
      if (me && me.hp_max > 0) st.hpMax = me.hp_max;
      if (me && typeof me.realm_id === 'number') st.realm = me.realm_id;
    }
    hpPct() { const { hp, hpMax } = this.st; return typeof hp === 'number' && hpMax > 0 ? hp / hpMax : null; }
    hpText() { const { hp, hpMax } = this.st; const p = this.hpPct(); return p == null ? `${hp}` : `${hp}/${hpMax} = ${Math.round(p * 100)}%`; }
    syncHp(c) { if (typeof c.hp === 'number') this.st.hp = c.hp; if (c.hpMax > 0) this.st.hpMax = c.hpMax; }
    // Ngưỡng MP / HP (chỉ tính ngưỡng đang BẬT): trả về các mức đang ≤ mức tạm dừng, vd. ['MP', 'HP']; rỗng = được chạy
    get mpG() { return this.gate.modes[this.hpKey] || MpGate.OFF; }   // ngưỡng MP của chế độ này
    get hpG() { return this.hpGate.modes[this.hpKey] || HpGate.OFF; } // ngưỡng HP của chế độ này
    lowKinds() {
      if (!this.api.getMe) return [];
      const out = [], p = this.pct(), h = this.hpPct();
      const mg = this.mpG, hg = this.hpG;
      if (mg.enabled !== false && p != null && p <= mg.pause) out.push('MP');
      if (hg.enabled !== false && h != null && h <= hg.pause) out.push('HP');
      return out;
    }
    // Trước khi mở trận mới (tầm bảo, săn yêu, leo tháp) / trước khi vào U Minh Cốc: MP hoặc HP ≤ ngưỡng tạm dừng thì dùng đan (nếu bật cho chế độ này),
    // chưa đủ thì tạm dừng, kiểm tra lại mỗi FARM_MP_CHECK_MS, chạy tiếp khi mức đó > ngưỡng chạy tiếp. stopWhen() = true thì thôi chờ.
    // Trả về true nếu được chạy tiếp.
    async waitGate(alive, stopWhen = () => false) {
      const { st } = this, gate = this.mpG, hpGate = this.hpG;
      const need = this.lowKinds();
      if (!need.length) return true;
      if (need.includes('MP')) {
        const pu = await this.pills.topUp(st.mp, st.mpMax, alive, true, false, gate.resume);
        if (pu) { st.mp = pu.mp; st.mpMax = pu.mpMax; if (pu.hp !== undefined) st.hp = pu.hp; if (pu.hpMax > 0) st.hpMax = pu.hpMax; }
      }
      if (need.includes('HP')) {
        const hu = await this.hpPills.topUp(st.hp, st.hpMax, alive, true, hpGate.resume);
        if (hu) { st.hp = hu.hp; if (hu.hpMax > 0) st.hpMax = hu.hpMax; if (typeof hu.mp === 'number') st.mp = hu.mp; if (hu.mpMax > 0) st.mpMax = hu.mpMax; }
      }
      if (need.every(k => (k === 'MP' ? this.pct() >= gate.resume : this.hpPct() >= hpGate.resume))) return true; // đan kéo tới đúng mức chạy tiếp (>=, vì đan dừng ngay khi chạm mức đó)
      if (!alive()) return false;
      const what = () => need.map(k => (k === 'MP' ? `MP ${this.pctText()}` : `HP ${this.hpText()}`)).join(', ');
      const resumeTxt = need.map(k => (k === 'MP' ? `MP > ${Math.round(gate.resume * 100)}%` : `HP > ${Math.round(hpGate.resume * 100)}%`)).join(' và ');
      this.log(`${what()} thấp: tạm dừng ${this.modeName}, kiểm tra lại mỗi ${CFG.FARM_MP_CHECK_MS / 60000} phút, chạy tiếp khi ${resumeTxt}.`);
      const live = () => alive() && !stopWhen();
      while (live()) {
        await sleepSlices(this.sleep, CFG.FARM_MP_CHECK_MS, live);
        if (!live()) return false;
        try { await this.refreshMe(); st.errors = 0; }
        catch (e) {
          st.errors++;
          this.log(`Lỗi khi kiểm tra HP / MP: ${e.message} (lần ${st.errors}, thử lại sau ${this.errWaitSec()}s)`);
          continue;
        }
        if (need.some(k => (k === 'MP' ? this.pct() : this.hpPct()) == null)) { this.log('Không đọc được HP / MP từ game, thử lại sau.'); continue; }
        if (need.every(k => (k === 'MP' ? this.pct() > gate.resume : this.hpPct() > hpGate.resume))) { this.log(`${what()} đã hồi → tiếp tục ${this.modeName}.`); return true; }
        this.log(`${what()}, chưa vượt ngưỡng chạy tiếp (${resumeTxt}), chờ tiếp...`);
      }
      return false;
    }
    // Tạm dừng khi MP <= pause; cứ 2 phút kiểm tra lại; chỉ chạy tiếp khi MP > resume. Trả về true nếu được chạy tiếp.
    async waitMp(alive) {
      const { st } = this, gate = this.mpG;
      // có đan hồi MP thì dùng trước; chỉ coi là xong khi MP đã vượt ngưỡng tạm dừng
      const pu = await this.pills.topUp(st.mp, st.mpMax, alive, true);
      if (pu) { st.mp = pu.mp; st.mpMax = pu.mpMax; if (this.pct() > gate.pause) return true; }
      if (!alive()) return false;
      this.log(`MP thấp (${this.pctText()}): tạm dừng ${this.modeName}, kiểm tra lại mỗi ${CFG.FARM_MP_CHECK_MS / 60000} phút, chạy tiếp khi MP > ${Math.round(gate.resume * 100)}%.`);
      while (alive()) {
        await sleepSlices(this.sleep, CFG.FARM_MP_CHECK_MS, alive);
        if (!alive()) return false;
        try { await this.refreshMe(); st.errors = 0; }
        catch (e) {
          st.errors++;
          this.log(`Lỗi khi kiểm tra MP: ${e.message} (lần ${st.errors}, thử lại sau ${this.errWaitSec()}s)`);
          continue;
        }
        const p = this.pct();
        if (p == null) { this.log('Không đọc được MP từ game, thử lại sau.'); continue; }
        if (p > gate.resume) { this.log(`MP đã hồi (${this.pctText()}) → tiếp tục ${this.modeName}.`); return true; }
        this.log(`MP ${this.pctText()}, chưa vượt ${Math.round(gate.resume * 100)}%, chờ tiếp...`);
      }
      return false;
    }

    /* --- một trận đánh: chạy FSM battle đến khi kết thúc. match = dữ liệu từ explore/hunt start hoặc state --- */
    async fightMatch(match, alive) {
      const { st } = this;
      const c = {
        alive, match,
        el: match.monster && match.monster.element,
        skills: (match.player && match.player.skills) || [], snapshot: (match.player && match.player.skills) || [],
        mp: match.player_mp, hp: match.player_hp, hpMax: match.player && match.player.hp_max,
        warnedHeal: false, foeMax: match.monster && match.monster.hp_max,
        act: null, res: null, result: 'stopped',
      };
      if (typeof c.mp === 'number') st.mp = c.mp;
      if (match.player && typeof match.player.mp_max === 'number') st.mpMax = match.player.mp_max;
      this.syncHp(c);
      this.log(`Gặp ${match.monster ? match.monster.name : '?'} (${c.el || '?'})`);
      await this.battle.run('PILL', c);
      return c.result;
    }
    finish(c, result) { c.result = result; return null; }

    // Trận đang dở ở server (null nếu không có): lớp con ghi đè, dùng cho reset mềm khi đánh lỗi lặp
    async fetchCurrent() { return null; }
    resyncBattle(c, m) {
      c.match = m; c.el = m.monster && m.monster.element;
      const sk = (m.player && m.player.skills) || c.skills; c.skills = sk; c.snapshot = sk;
      if (typeof m.player_mp === 'number') c.mp = m.player_mp;
      if (typeof m.player_hp === 'number') c.hp = m.player_hp;
      c.frozen = false; c.act = null; c.warnedHeal = false;
    }
    // Đang kẹt trong U Minh Cốc (chặn tầm bảo / săn yêu / leo tháp vào trận): U Minh tool đang chạy thì nhường, lặp lỗi mà không ai dùng thì rời U Minh Cốc
    async stuckInUMinh(e, alive) {
      const v = this.trackError(e);
      if (this.coord.um) this.clearErrors();
      else if (v !== 'ok' && this.api.uminhLeave) {
        try { await this.api.uminhLeave(); this.log('Đang kẹt trong U Minh Cốc (chặn vào trận): đã rời U Minh Cốc để chạy tiếp.'); this.clearErrors(); this.st.errors = 0; return; }
        catch (err) { this.log(`Không rời được U Minh Cốc: ${err.message}`); }
      }
      await sleepSlices(this.sleep, 10000, alive);
    }

    // Túi đầy (phần thưởng không nhận được): đặt cờ, các trận mới sẽ chờ ở waitBag tới khi túi có chỗ
    async noteBagFull() {
      const { st } = this;
      st.bagFull = true; st.bagCount = null;
      try { const inv = await this.api.getInventory(1); if (Array.isArray(inv)) st.bagCount = inv.length; } catch (_) {}
      this.log('Túi đồ đầy! Tạm dừng mở trận mới để không mất vật phẩm, kiểm tra lại mỗi ' + CFG.BAG_FULL_WAIT_MS / 1000 + 's, có chỗ trống là chạy tiếp.');
    }
    // Chờ túi có chỗ (số dòng vật phẩm ít hơn lúc đầy). Trả về true khi được đánh tiếp, false khi bị tắt.
    async waitBag(alive) {
      const { st } = this;
      while (alive() && st.bagFull) {
        await sleepSlices(this.sleep, CFG.BAG_FULL_WAIT_MS, alive);
        if (!alive()) return false;
        try {
          const inv = await this.api.getInventory(1);
          if (Array.isArray(inv) && (st.bagCount == null || inv.length < st.bagCount)) { st.bagFull = false; this.log('Túi đồ đã có chỗ trống, chạy tiếp.'); }
          else if (Array.isArray(inv) && st.bagCount == null) st.bagCount = inv.length;
        } catch (_) {}
      }
      return alive();
    }

    // MP thấp -> dùng đan hồi MP (nếu bật)
    async bPill(c) {
      if (!c.alive()) return this.finish(c, 'stopped');
      const { st } = this;
      await this.refreshSkills(c); // mọi đòn (kể cả sau chờ MP / dưỡng thương / lỗi) đều đi qua đây
      const pu = await this.pills.topUp(c.mp, st.mpMax, c.alive, false);
      if (pu) { c.mp = st.mp = pu.mp; st.mpMax = pu.mpMax; if (pu.hp !== undefined) c.hp = pu.hp; if (pu.hpMax > 0) c.hpMax = pu.hpMax; }
      const hu = await this.hpPills.topUp(c.hp, c.hpMax, c.alive); // HP < x% → đan hồi HP tới y% (nếu bật)
      if (hu) { c.hp = hu.hp; if (hu.hpMax > 0) c.hpMax = hu.hpMax; if (typeof hu.mp === 'number') c.mp = st.mp = hu.mp; if (hu.mpMax > 0) st.mpMax = hu.mpMax; }
      this.syncHp(c);
      if (!c.alive()) return this.finish(c, 'stopped');
      return 'CHOOSE';
    }

    // HP < 45% và có chiêu heal đủ MP -> đòn kế tiếp là heal; ngược lại chọn chiêu tấn công như thường
    async bChoose(c) {
      const viaPill = this.hpPills.covers(); // đan hồi HP lo việc hồi máu → không dùng chiêu heal
      const want = this.healCfg.update(this.hpKey, c.hp, c.hpMax, c); // mức hồi máu của chiêu heal (x% – y%) theo chế độ
      const heal = viaPill ? null : SkillSelector.pickHeal(c.skills, c.hp, c.hpMax, c.mp, want);
      if (!heal && !viaPill && (want === undefined ? SkillSelector.isLowHp(c.hp, c.hpMax) : want) && !c.warnedHeal) {
        c.warnedHeal = true;
        this.log(`HP thấp (${c.hp}/${c.hpMax}) nhưng ${SkillSelector.noHealReason(c.skills)}, tiếp tục đánh.`);
      }
      if (heal) c.warnedHeal = false;
      const act = heal || SkillSelector.pickAttack(c.skills, c.el, c.mp);
      if (!act) {
        // hết MP giữa trận: chờ MP hồi rồi đánh tiếp đúng trận này
        if (SkillSelector.noSkillCause(c.skills, c.el, c.mp) === 'mp' && this.api.getMe) {
          if (!(await this.waitMp(c.alive))) return this.finish(c, 'stopped');
          c.mp = this.st.mp;
          return 'PILL';
        }
        await this.waitSkills(c); // không có chiêu tấn công nào: chờ rồi đọc lại chiêu + MP, không tắt
        return 'PILL';
      }
      c.act = act;
      return 'GAP';
    }

    async bGap(c) {
      await this.waitGap();
      if (!c.alive()) return this.finish(c, 'stopped');
      return 'ACT';
    }

    async bAct(c) {
      const { st } = this;
      this.markAttack();
      try { c.res = await this.doAction({ action: 'skill', skillId: c.act.skill.id }); st.errors = 0; this.clearErrors(); this.healer.done(); }
      catch (e) {
        if (isInjuredError(e)) { st.errors = 0; return 'RECOVER'; } // trọng thương giữa trận: chờ rồi đánh tiếp đúng trận này
        if (/chưa học\/trang bị|chưa học.*võ kỹ/i.test(e.message || '') && !c.frozen && c.snapshot && c.snapshot.length) {
          // server dùng bộ chiêu lúc bắt đầu trận: chiêu mới trang bị giữa trận chưa dùng được → quay về bộ chiêu cũ tới hết trận
          c.frozen = true; c.skills = c.snapshot; st.errors = 0;
          if (this.onSkillLock) this.onSkillLock(c);
          this.log(`Chiêu "${c.act && c.act.skill ? c.act.skill.name || '#' + c.act.skill.id : '?'}" mới trang bị chưa dùng được trong trận này (server giữ bộ chiêu lúc bắt đầu trận). Dùng lại bộ chiêu cũ, chiêu mới áp dụng từ trận sau.`);
          return 'PILL';
        }
        if (/không có trận đấu nào/i.test(e.message || '') && this.onNoBattle) { st.errors = 0; return this.finish(c, 'nobattle'); } // trận đã bị đánh tay / hết hạn
        if (this.onClosedError && this.onClosedError(e)) { st.errors = 0; return this.finish(c, 'closed'); } // (U Minh Cốc) game báo đã đóng cửa: hết phiên, không thử lại
        st.errors++;
        this.log(`Lỗi đánh: ${e.message} (lần ${st.errors}, thử lại sau ${this.errWaitSec()}s)`);
        const v = this.trackError(e);
        if (v !== 'ok') { // lỗi lặp: không đánh lại y nguyên, đọc lại trận từ server rồi đánh tiếp (không có lệnh bỏ trận)
          this.log(`Lỗi lặp "${e.message}" → reset mềm: đọc lại trận từ server${v === 'hold' ? ' (sau reset vẫn lỗi, chờ lâu hơn)' : ''}.`);
          let m = null; try { m = await this.fetchCurrent(); } catch (_) {}
          if (v === 'hold') await sleepSlices(this.sleep, CFG.ERR_BACKOFF_CAP_MS, c.alive);
          if (!c.alive()) return this.finish(c, 'stopped');
          if (!m) return this.finish(c, 'nobattle'); // server không còn trận: quay lại vòng ngoài mở trận mới
          this.resyncBattle(c, m);
          return 'PILL';
        }
        await sleepSlices(this.sleep, this.errWaitMs(), c.alive);
        return 'PILL';
      }
      return 'RESOLVE';
    }

    async bRecover(c) {
      if ((await this.healer.step(c.alive)) === 'stopped') return this.finish(c, 'stopped');
      return 'PILL';
    }

    async bResolve(c) {
      const { st } = this; const act = c.act;
      const d = (c.res && c.res.data) || {};
      const m = d.match;
      if (d.ticketState && typeof d.ticketState.tickets === 'number') this.setTickets(d.ticketState.tickets);
      if (d.character && typeof d.character.mp === 'number') c.mp = d.character.mp;
      else if (m && typeof m.player_mp === 'number') c.mp = m.player_mp;
      if (typeof c.mp === 'number') st.mp = c.mp;
      if (d.character && typeof d.character.mp_max === 'number') st.mpMax = d.character.mp_max;
      let hpSeen = false;
      if (d.character && typeof d.character.hp === 'number') { c.hp = d.character.hp; hpSeen = true; }
      else if (m && typeof m.player_hp === 'number') { c.hp = m.player_hp; hpSeen = true; }
      if (d.character && d.character.hp_max > 0) c.hpMax = d.character.hp_max;
      this.syncHp(c);
      if (act.heal && !hpSeen && this.api.getMe) { // phản hồi không có HP: đọc lại, tránh heal lặp vô hạn
        try { const me = await this.api.getMe(); if (me && typeof me.hp === 'number') c.hp = me.hp; if (me && me.hp_max > 0) c.hpMax = me.hp_max; } catch (_) {}
      }
      const hits = CombatFormatter.sumHits(d.roundLog || (m && m.battle_log), act.skill.name);
      if (m && m.monster && m.monster.hp_max > 0) c.foeMax = m.monster.hp_max;
      const label = CombatFormatter.fightLine({
        name: act.skill.name, rel: act.rel, heal: !!act.heal, dealt: hits.dealt,
        foeHp: d.finished ? 0 : (m ? m.monster_hp : undefined), foeMax: c.foeMax,
        taken: hits.taken, hp: c.hp, hpMax: c.hpMax, mp: c.mp, mpMax: st.mpMax,
      });
      if (!d.finished) { this.log((act.heal ? '💚 ' : '') + label); return 'PILL'; }
      if (d.result === 'win') {
        st.kills++;
        const r = d.rewards || {};
        const items = (r.itemsDropped || []).map(i => `${i.name} x${i.quantity}`).join(', ');
        this.log(`${label} → THẮNG #${st.kills}: +${r.expGained ?? 0} tu vi, +${r.lockedSpiritStonesGained ?? 0} linh thạch khóa${items ? ', nhặt: ' + items : ''}`);
        if (r.bagFull) await this.noteBagFull();
        return this.finish(c, 'win');
      }
      return this.onNonWin(c, d);
    }

    // Trận kết thúc không phải thắng. Mặc định (tầm bảo / săn yêu): dừng để bạn kiểm tra. Lớp con có thể ghi đè.
    onNonWin(c, d) {
      this.log(`Trận kết thúc với kết quả "${d.result}", tự dừng để bạn kiểm tra.`);
      this.st.running = false;
      return this.finish(c, d.result || 'end');
    }
  }
  MatchEngine.BATTLE_TRANSITIONS = {
    PILL: ['CHOOSE'], CHOOSE: ['PILL', 'GAP'], GAP: ['ACT'], ACT: ['RESOLVE', 'RECOVER', 'PILL'], RECOVER: ['PILL'], RESOLVE: ['PILL'],
  };

  /* ---------------------------------------------------------------------
   *  TẦM BẢO
   *  FSM: INIT → DISPATCH → (YIELD | MP_WAIT | EXPLORE → BATTLE) → DISPATCH ...
   * --------------------------------------------------------------------- */
  class FarmEngine extends MatchEngine {
    constructor(deps) {
      super(deps);
      this.machine = this.track(new StateMachine('farm', {
        INIT: c => this.sInit(c), DISPATCH: c => this.sDispatch(c), YIELD: c => this.sYield(c), MP_WAIT: c => this.sMpWait(c),
        EXPLORE: c => this.sExplore(c), BATTLE: c => this.sBattle(c), TICKET_WAIT: c => this.sTicketWait(c),
      }, FarmEngine.TRANSITIONS));
    }
    get hpKey() { return 'farm'; }
    get modeName() { return 'tầm bảo'; }
    get startMessage() { return `BẮT ĐẦU auto tầm bảo (Bí Cảnh ${this.zoneName()}).`; }
    get stopMessage() { return 'ĐÃ DỪNG tầm bảo.'; }
    zoneName() { return (ZONES.find(z => z[0] === this.st.zone) || [0, this.st.zone])[1]; }
    releaseFlags() { this.coord.farm = false; }
    doAction(body) { return this.api.farmAction(body); }
    async fetchCurrent() { const cur = await this.api.farmState(); const m0 = cur && (cur.match || cur); return m0 && m0.monster && m0.player ? m0 : null; }
    // tầm bảo: kết thúc không phải thắng thì ghi log rồi đánh tiếp (không tự dừng)
    onNonWin(c, d) { this.log(`Trận kết thúc với kết quả "${d.result}", đánh tiếp.`); return this.finish(c, d.result || 'end'); }
    execute(alive) { return this.machine.run('INIT', { alive, yieldLogged: false, match: null }); }

    // đánh nốt trận đang dở (nếu có)
    async resume(alive) {
      const cur = await this.api.farmState();
      const m0 = cur && (cur.match || cur);
      if (m0 && m0.monster && m0.player) {
        this.log('Tiếp tục trận đang dở...');
        this.coord.farm = true;
        try { return await this.fightMatch(m0, alive); } finally { this.coord.farm = false; }
      }
      return null;
    }

    async sInit(c) {
      const zones = await this.api.getZones();
      const z = (zones || []).find(x => x.code === this.st.zone);
      if (z && z.locked) { await this.waitConfig(c.alive, `Bí Cảnh ${z.name} chưa mở khóa (cảnh giới chưa đủ), hãy chọn bí cảnh khác`); return 'INIT'; }
      if (this.api.getMe) { try { await this.refreshMe(); } catch (_) {} } // biết MP ngay từ đầu
      await this.resume(c.alive);
      return 'DISPATCH';
    }

    async sDispatch(c) {
      const { coord, st } = this;
      if (!c.alive()) return null;
      await this.skillGate(); // sau mỗi trận: đổi chiêu đang chờ ngay trước khi mở trận mới
      if (coord.bt) { await this.sleep(500); return 'DISPATCH'; } // đang chờ để đột phá: không mở trận mới
      if (this.bossWindow) { // 3 phút đầu giờ dành cho boss: không mở trận mới
        if (!c.winLogged) { this.log('3 phút đầu giờ dành cho boss: tầm bảo tạm không mở trận mới...'); c.winLogged = true; }
        await this.sleep(1000); return 'DISPATCH';
      }
      c.winLogged = false;
      if (this.st.bagFull && !(await this.waitBag(c.alive))) return null; // túi đầy: không mở trận mới
      if (coord.boss || coord.hunt || coord.um || coord.tower) return 'YIELD'; // ưu tiên: boss > U Minh Cốc > săn yêu > leo tháp > tầm bảo
      c.yieldLogged = false;
      // MP còn <= ngưỡng thì tạm dừng (không giữ cờ coord.farm để boss vẫn vào đánh được)
      const p = this.pct();
      if (this.lowKinds().length) return 'MP_WAIT';
      if (st.tickets === 0) return 'TICKET_WAIT'; // hết vé tầm bảo: chờ tới đầu giờ sau
      return 'EXPLORE';
    }

    // Hết vé tầm bảo: không mở trận mới, chờ tới đầu giờ kế tiếp rồi thử lại (chưa có vé thì chờ giờ sau nữa)
    async sTicketWait(c) {
      const { st } = this, now = this.now();
      const next = (Math.floor(now / 3600000) + 1) * 3600000 + CFG.FARM_TICKET_WAIT_MARGIN_MS;
      this.log(`Hết vé tầm bảo (0/${st.maxTickets || '?'}). Chờ tới đầu giờ sau (${new Date(next).toLocaleTimeString()}) rồi thử lại.`);
      await sleepSlices(this.sleep, next - now, c.alive);
      if (!c.alive()) return null;
      st.tickets = null; this.emit('tickets', null);
      return 'DISPATCH';
    }

    async sYield(c) {
      if (!c.yieldLogged) { this.log(`Đang ${this.coord.boss ? 'đánh boss' : this.coord.um ? 'đi U Minh Cốc' : this.coord.hunt ? 'săn yêu' : 'leo tháp'}, tầm bảo tạm nhường...`); c.yieldLogged = true; }
      await this.sleep(1000);
      return 'DISPATCH';
    }

    async sMpWait(c) {
      if (!(await this.waitGate(c.alive))) return null;
      return 'DISPATCH';
    }

    async sExplore(c) {
      const { coord, st, api } = this;
      coord.farm = true; // đặt cờ ngay, trước mọi await, để boss không chen vào giữa trận
      await this.exploreBreak(); // nghỉ ngắn giữa các trận
      if (!c.alive()) { coord.farm = false; return null; }
      if (coord.boss || coord.hunt || coord.tower) { coord.farm = false; return 'DISPATCH'; } // boss / săn yêu / leo tháp vừa tới trong lúc nghỉ: nhường
      try {
        c.match = await api.explore(st.zone); st.errors = 0; this.clearErrors(); this.healer.done();
        const tk = c.match && c.match.tickets; // { tickets, maxTickets, refillSeconds, secondsToNextTicket }
        if (tk && typeof tk.tickets === 'number') { if (tk.maxTickets > 0) st.maxTickets = tk.maxTickets; this.setTickets(tk.tickets); }
      }
      catch (e) {
        if (/(?:^|[^\p{L}])vé(?![\p{L}])|ticket/iu.test(e.message || '')) { st.errors = 0; coord.farm = false; this.setTickets(0); return 'DISPATCH'; } // hết vé: DISPATCH sẽ chuyển sang chờ đầu giờ sau
        if (isInjuredError(e)) { // trọng thương lúc vào bí cảnh: nhả cờ cho boss, chờ rồi thử lại
          st.errors = 0; coord.farm = false;
          if ((await this.healer.step(c.alive)) === 'stopped') return null;
          return 'DISPATCH';
        }
        if (/Đang ở trong U Minh/i.test(e.message || '')) { coord.farm = false; await this.stuckInUMinh(e, c.alive); return 'DISPATCH'; }
        coord.farm = false;
        if (await this.waitXuatHon(c.alive, e, true)) { st.errors = 0; return c.alive() ? 'DISPATCH' : null; } // đang xuất hồn: bỏ lượt (không chạy song song với tầm bảo) rồi đi tiếp
        coord.farm = true;
        st.errors++;
        this.log(`Lỗi vào bí cảnh: ${e.message} (lần ${st.errors}, thử lại sau ${this.errWaitSec()}s)`);
        if (this.trackError(e) !== 'ok') { // lỗi lặp: reset mềm, chờ 1 phút rồi đọc lại trạng thái từ đầu
          this.log(`Lỗi lặp "${e.message}" → reset mềm, chờ ${CFG.REPEAT_START_WAIT_MS / 1000}s rồi đọc lại trạng thái.`);
          coord.farm = false; await sleepSlices(this.sleep, CFG.REPEAT_START_WAIT_MS, c.alive); return 'INIT';
        }
        try {
          const cur = await api.farmState().catch(() => null); // có thể đang kẹt trong trận cũ
          const m0 = cur && (cur.match || cur);
          if (m0 && m0.monster && m0.player) await this.fightMatch(m0, c.alive);
          else await this.sleep(this.errWaitMs());
        } finally { coord.farm = false; }
        return 'DISPATCH';
      }
      return 'BATTLE';
    }

    async sBattle(c) {
      try { await this.fightMatch(c.match, c.alive); } finally { this.coord.farm = false; }
      return 'DISPATCH';
    }
  }
  FarmEngine.TRANSITIONS = {
    INIT: ['INIT', 'DISPATCH'], DISPATCH: ['DISPATCH', 'YIELD', 'MP_WAIT', 'EXPLORE', 'TICKET_WAIT'], YIELD: ['DISPATCH'], MP_WAIT: ['DISPATCH'], EXPLORE: ['DISPATCH', 'BATTLE', 'INIT'], BATTLE: ['DISPATCH'], TICKET_WAIT: ['DISPATCH'],
  };

  /* ---------------------------------------------------------------------
   *  SĂN YÊU
   *  FSM: INIT → DISPATCH → (YIELD | PREPARE → (MP_WAIT | TICKETS → (WAIT_TICKETS | START → BATTLE))) → DISPATCH ...
   * --------------------------------------------------------------------- */
  class HuntEngine extends MatchEngine {
    constructor(deps) {
      super(deps);
      this.machine = this.track(new StateMachine('hunt', {
        INIT: c => this.sInit(c), DISPATCH: c => this.sDispatch(c), YIELD: c => this.sYield(c), PREPARE: c => this.sPrepare(c),
        MP_WAIT: c => this.sMpWait(c), TICKETS: c => this.sTickets(c), WAIT_TICKETS: c => this.sWaitTickets(c),
        START: c => this.sStart(c), BATTLE: c => this.sBattle(c),
      }, HuntEngine.TRANSITIONS));
    }
    get hpKey() { return 'hunt'; }
    get modeName() { return 'săn yêu'; }
    get startMessage() { return 'BẮT ĐẦU auto săn yêu.'; }
    get stopMessage() { return 'ĐÃ DỪNG săn yêu.'; }
    releaseFlags() { this.coord.hunt = false; }
    doAction(body) { return this.api.huntAction(body); }
    execute(alive) { return this.machine.run('INIT', { alive, yieldLogged: false, match: null, tk: null, tkState: { logged: false } }); }

    async fetchCurrent() { return this.currentHuntMatch(); }
    // Lấy trận đang dở của săn yêu (nếu có). Phản hồi có thể là chính trận hoặc bọc trong { match }.
    async currentHuntMatch() {
      const cur = await this.api.huntState();
      const m0 = cur && (cur.match || cur);
      return m0 && m0.monster && m0.player ? m0 : null;
    }

    // Chờ có vé săn (vé hồi 1 lượt / 60 phút, hỏi lại tối đa mỗi 5 phút)
    async waitTickets(alive, tk, state) {
      const secs = tk && typeof tk.secondsToNextTicket === 'number' ? tk.secondsToNextTicket : 600;
      if (!state.logged) {
        this.log(`Hết vé săn (${tk && typeof tk.tickets === 'number' ? tk.tickets : 0}/${(tk && tk.maxTickets) || 10}). Vé kế tiếp sau ~${Math.ceil(secs / 60)} phút. Chờ, tầm bảo (nếu bật) được chạy trong lúc này.`);
        state.logged = true;
      }
      await sleepSlices(this.sleep, Math.min(Math.max(secs, 5) * 1000 + 3000, CFG.HUNT_TICKET_MAX_WAIT_MS), alive);
    }

    async sInit(c) {
      const { st, coord } = this;
      // chọn yêu: theo lựa chọn của bạn, chưa chọn thì dùng mặc định (required_realm lớn nhất đánh được, id nhỏ nhất)
      let monsters;
      try { monsters = MonsterCatalog.sort(await this.api.getMonsters()); }
      catch (e) { this.st.errors++; this.log(`Không tải được danh sách yêu: ${e.message} (thử lại sau ${this.errWaitSec()}s)`); await sleepSlices(this.sleep, this.errWaitMs(), c.alive); return 'INIT'; }
      if (this.api.getMe) { try { await this.refreshMe(); } catch (_) {} } // biết MP, cảnh giới ngay từ đầu
      let target = monsters.find(x => x.id === st.monsterId);
      if (!target) {
        target = MonsterCatalog.pickDefault(monsters, st.realm);
        if (!target) { await this.waitConfig(c.alive, 'Không có yêu nào đánh được (không đọc được cảnh giới hoặc danh sách trống)'); return 'INIT'; }
        st.monsterId = target.id;
        this.log(`Chưa chọn yêu, dùng mặc định: ${MonsterCatalog.label(target, st.realm)}`);
      }
      if (!MonsterCatalog.canFight(target, st.realm)) {
        await this.waitConfig(c.alive, `Cảnh giới chưa đủ để săn ${target.name}: cần ${target.required_realm}, hiện tại ${st.realm}. Hãy chọn yêu khác`);
        return 'INIT';
      }
      this.log(`Săn: ${MonsterCatalog.label(target, st.realm)}`);

      // trận đang dở thì đánh nốt trước
      try {
        const m0 = await this.currentHuntMatch();
        if (m0) {
          this.log('Tiếp tục trận săn đang dở...');
          coord.hunt = true;
          try { await this.fightMatch(m0, c.alive); } finally { coord.hunt = false; }
        }
      } catch (e) { this.log(`Không đọc được trận đang dở: ${e.message}`); }
      return 'DISPATCH';
    }

    async sDispatch(c) {
      const { coord } = this;
      if (!c.alive()) return null;
      await this.skillGate(); // sau mỗi trận: đổi chiêu đang chờ ngay trước khi mở trận mới
      if (coord.bt) { await this.sleep(500); return 'DISPATCH'; } // đang chờ để đột phá: không mở trận mới
      if (this.bossWindow) { // 3 phút đầu giờ dành cho boss: không mở trận mới
        if (!c.winLogged) { this.log('3 phút đầu giờ dành cho boss: săn yêu tạm không mở trận mới...'); c.winLogged = true; }
        await this.sleep(1000); return 'DISPATCH';
      }
      c.winLogged = false;
      if (this.st.bagFull && !(await this.waitBag(c.alive))) return null; // túi đầy: không mở trận mới
      if (coord.boss || coord.um) return 'YIELD';                // ưu tiên: boss > U Minh Cốc > săn yêu > tầm bảo
      c.yieldLogged = false;
      coord.hunt = true; // đặt cờ ngay (đồng bộ): tầm bảo sẽ nhường từ vòng kế tiếp của nó
      return 'PREPARE';
    }

    async sYield(c) {
      if (!c.yieldLogged) { this.log(`Đang ${this.coord.boss ? 'đánh boss' : 'đi U Minh Cốc'}, săn yêu tạm nhường...`); c.yieldLogged = true; }
      await this.sleep(1000);
      return 'DISPATCH';
    }

    async sPrepare(c) {
      const { coord } = this;
      while ((coord.farm || coord.towerBattle) && c.alive() && !coord.boss) await this.sleep(500); // đợi trận tầm bảo / leo tháp đang dở kết thúc
      if (coord.boss) { coord.hunt = false; return 'DISPATCH'; }            // boss vừa tới: nhả cờ, nhường boss
      if (!c.alive()) { coord.hunt = false; return null; }
      // MP còn <= ngưỡng thì tạm dừng, nhả cờ để tầm bảo/boss vẫn chạy được
      const p = this.pct();
      if (this.lowKinds().length) { coord.hunt = false; return 'MP_WAIT'; }
      return 'TICKETS';
    }

    async sMpWait(c) {
      if (!(await this.waitGate(c.alive))) return null;
      return 'DISPATCH';
    }

    // còn vé không?
    async sTickets(c) {
      const { st, coord } = this;
      let tk = null;
      try { tk = await this.api.getTickets(); } // không xóa bộ đếm lỗi ở đây: chỉ vào trận thành công mới xóa
      catch (e) {
        st.errors++;
        this.log(`Lỗi đọc vé săn: ${e.message} (lần ${st.errors}, thử lại sau ${this.errWaitSec()}s)`);
        coord.hunt = false;
        await this.sleep(this.errWaitMs());
        return 'DISPATCH';
      }
      if (tk && typeof tk.tickets === 'number') this.setTickets(tk.tickets);
      if (tk && tk.tickets <= 0) { coord.hunt = false; c.tk = tk; return 'WAIT_TICKETS'; } // nhả cờ trong lúc chờ vé để tầm bảo chạy
      c.tkState.logged = false;
      return 'START';
    }

    async sWaitTickets(c) {
      await this.waitTickets(c.alive, c.tk, c.tkState);
      return 'DISPATCH';
    }

    async sStart(c) {
      const { st, coord, api } = this;
      await this.exploreBreak(); // nghỉ ngắn giữa các trận
      if (!c.alive() || coord.boss) { coord.hunt = false; return 'DISPATCH'; }
      try { c.match = await api.huntStart(st.monsterId); st.errors = 0; this.clearErrors(); this.healer.done(); }
      catch (e) {
        if (isInjuredError(e)) { // trọng thương lúc vào trận: nhả cờ, chờ rồi thử lại
          st.errors = 0; coord.hunt = false;
          if ((await this.healer.step(c.alive)) === 'stopped') return null;
          return 'DISPATCH';
        }
        if (/Đang ở trong U Minh/i.test(e.message || '')) { coord.hunt = false; await this.stuckInUMinh(e, c.alive); return 'DISPATCH'; }
        // hết vé giữa chừng? hay đang kẹt trong trận cũ? -> kiểm tra trước khi tính là lỗi
        const tk2 = await api.getTickets().catch(() => null);
        if (tk2 && tk2.tickets <= 0) { coord.hunt = false; c.tk = tk2; return 'WAIT_TICKETS'; }
        st.errors++;
        this.log(`Lỗi vào trận săn: ${e.message} (lần ${st.errors}, thử lại sau ${this.errWaitSec()}s)`);
        if (this.trackError(e) !== 'ok') {
          this.log(`Lỗi lặp "${e.message}" → reset mềm, chờ ${CFG.REPEAT_START_WAIT_MS / 1000}s rồi đọc lại trạng thái.`);
          coord.hunt = false; await sleepSlices(this.sleep, CFG.REPEAT_START_WAIT_MS, c.alive); return 'INIT';
        }
        try {
          const m0 = await this.currentHuntMatch().catch(() => null);
          if (m0) await this.fightMatch(m0, c.alive);
          else await this.sleep(this.errWaitMs());
        } finally { coord.hunt = false; }
        return 'DISPATCH';
      }
      return 'BATTLE';
    }

    async sBattle(c) {
      try { await this.fightMatch(c.match, c.alive); } finally { this.coord.hunt = false; }
      return 'DISPATCH';
    }
  }
  HuntEngine.TRANSITIONS = {
    INIT: ['INIT', 'DISPATCH'], DISPATCH: ['DISPATCH', 'YIELD', 'PREPARE'], YIELD: ['DISPATCH'],
    PREPARE: ['DISPATCH', 'MP_WAIT', 'TICKETS'], MP_WAIT: ['DISPATCH'],
    TICKETS: ['DISPATCH', 'WAIT_TICKETS', 'START'], WAIT_TICKETS: ['DISPATCH'],
    START: ['DISPATCH', 'WAIT_TICKETS', 'BATTLE', 'INIT'], BATTLE: ['DISPATCH'],
  };

  /* ---------------------------------------------------------------------
   *  LEO THÁP
   *  FSM: INIT → DISPATCH → (YIELD | MP_WAIT | START → BATTLE) → DISPATCH ...
   *  Mỗi tầng: POST /api/tower/start → đánh (POST /api/tower/action {action:'skill'}) tới khi finished → start tầng kế.
   *  Ưu tiên: dưới boss / U Minh Cốc / săn yêu, trên tầm bảo. Thua TOWER_MAX_LOSSES lần liên tiếp thì tự dừng.
   * --------------------------------------------------------------------- */
  class TowerEngine extends MatchEngine {
    constructor(deps) {
      super(deps);
      Object.assign(this.st, { floor: null, best: null, wins: 0, losses: 0 });
      this.machine = this.track(new StateMachine('tower', {
        INIT: c => this.sInit(c), DISPATCH: c => this.sDispatch(c), YIELD: c => this.sYield(c), MP_WAIT: c => this.sMpWait(c),
        START: c => this.sStart(c), BATTLE: c => this.sBattle(c),
      }, TowerEngine.TRANSITIONS));
    }
    get hpKey() { return 'tower'; }
    get modeName() { return 'leo tháp'; }
    get startMessage() { return 'BẮT ĐẦU leo tháp.'; }
    get stopMessage() { return 'ĐÃ DỪNG leo tháp.'; }
    status(text) { this.emit('status', text); }
    releaseFlags() { this.coord.tower = false; this.coord.towerBattle = false; }
    // phản hồi action: đang đánh dở thì dữ liệu trận nằm ở "run" → gán thêm vào "match" cho bộ xử lý chung (MatchEngine.bResolve)
    async doAction(body) {
      const r = await this.api.towerAction(body);
      if (r && r.data && r.data.run && !r.data.match) r.data = { ...r.data, match: r.data.run };
      return r;
    }
    execute(alive) {
      this.coord.tower = true; // tầm bảo nhường từ giờ cho tới khi dừng
      this.st.losses = 0; this.st.wins = 0;
      return this.machine.run('INIT', { alive, yieldLogged: false, match: null });
    }
    async fetchCurrent() { const s = await this.api.towerState(); const run = s && s.run; return run && run.monster && run.player ? run : null; }
    // Thua (hoặc kết thúc không phải thắng): không dừng ngay, đếm liên tiếp; đủ TOWER_MAX_LOSSES thì dừng ở sBattle
    onNonWin(c, d) {
      const st = this.st; st.losses++;
      const fl = c.match && c.match.floor != null ? c.match.floor : st.floor;
      this.log(`THUA tầng ${fl} (kết quả "${d.result}"): thua liên tiếp ${st.losses}/${CFG.TOWER_MAX_LOSSES}.`);
      return this.finish(c, 'lose');
    }
    summary() { const st = this.st; return `Tầng ${st.floor ?? '?'}${st.best != null ? ` (cao nhất ${st.best})` : ''} · thắng ${st.wins} · thua liên tiếp ${st.losses}/${CFG.TOWER_MAX_LOSSES}`; }

    // đánh một trận (cờ towerBattle chỉ bật trong lúc đánh) rồi cập nhật thắng / thua
    async fight(match, alive) {
      const { st } = this;
      if (match && match.floor != null) st.floor = match.floor;
      this.coord.towerBattle = true;
      let r;
      try {
        r = await this.fightMatch(match, alive);
      } finally { this.coord.towerBattle = false; }
      if (r === 'win') { st.losses = 0; st.wins++; if (st.best == null || st.floor > st.best) st.best = st.floor; }
      this.status(this.summary());
      if (r === 'lose' && st.losses >= CFG.TOWER_MAX_LOSSES) {
        this.log(`Đã thua ${st.losses} lần liên tiếp, tự dừng leo tháp.`);
        st.running = false;
      }
      return r;
    }

    async sInit(c) {
      try {
        const s = await this.api.towerState();
        if (s && typeof s.bestFloor === 'number') { this.st.best = s.bestFloor; this.log(`Tầng cao nhất đã qua: ${s.bestFloor}.`); }
        const run = s && s.run;
        if (this.api.getMe) { try { await this.refreshMe(); } catch (_) {} }
        if (run && run.monster && run.player) { this.log('Tiếp tục trận tháp đang dở...'); await this.fight(run, c.alive); }
      } catch (e) { this.log(`Không đọc được trạng thái tháp: ${e.message}`); }
      return 'DISPATCH';
    }

    async sDispatch(c) {
      const { coord } = this;
      if (!c.alive()) return null;
      await this.skillGate(); // sau mỗi trận: đổi chiêu đang chờ ngay trước khi mở trận mới
      if (coord.bt) { await this.sleep(500); return 'DISPATCH'; } // đang chờ để đột phá
      if (this.bossWindow) { // 3 phút đầu giờ dành cho boss
        if (!c.winLogged) { this.log('3 phút đầu giờ dành cho boss: leo tháp tạm không mở trận mới...'); c.winLogged = true; }
        await this.sleep(1000); return 'DISPATCH';
      }
      c.winLogged = false;
      if (this.st.bagFull && !(await this.waitBag(c.alive))) return null; // túi đầy: không mở trận mới
      if (coord.boss || coord.hunt || coord.um) return 'YIELD'; // ưu tiên: boss > U Minh Cốc > săn yêu > leo tháp > tầm bảo
      if (coord.farm) { await this.sleep(500); return 'DISPATCH'; } // trận tầm bảo đang dở: đợi nó xong (tầm bảo sẽ không mở trận mới)
      c.yieldLogged = false;
      const p = this.pct();
      if (this.lowKinds().length) return 'MP_WAIT';
      return 'START';
    }

    async sYield(c) {
      if (!c.yieldLogged) { this.log(`Đang ${this.coord.boss ? 'đánh boss' : this.coord.um ? 'đi U Minh Cốc' : 'săn yêu'}, leo tháp tạm nhường...`); c.yieldLogged = true; }
      await this.sleep(1000);
      return 'DISPATCH';
    }

    async sMpWait(c) {
      if (!(await this.waitGate(c.alive))) return null;
      return 'DISPATCH';
    }

    async sStart(c) {
      const { coord, st, api } = this;
      coord.towerBattle = true; // đặt cờ ngay, trước mọi await
      await this.exploreBreak();
      if (!c.alive()) { coord.towerBattle = false; return null; }
      if (coord.boss || coord.hunt || coord.um || coord.bt) { coord.towerBattle = false; return 'DISPATCH'; } // bên ưu tiên cao hơn vừa tới
      try { c.match = await api.towerStart(); st.errors = 0; this.clearErrors(); this.healer.done(); }
      catch (e) {
        coord.towerBattle = false;
        if (isInjuredError(e)) { // trọng thương: chờ hồi rồi thử lại
          st.errors = 0;
          if ((await this.healer.step(c.alive)) === 'stopped') return null;
          return 'DISPATCH';
        }
        if (/Đang ở trong U Minh/i.test(e.message || '')) { await this.stuckInUMinh(e, c.alive); return 'DISPATCH'; }
        if (await this.waitXuatHon(c.alive, e)) { st.errors = 0; return c.alive() ? 'DISPATCH' : null; } // (nếu game từ chối khi đang xuất hồn) chờ xong rồi leo tiếp
        st.errors++;
        this.log(`Lỗi vào tháp: ${e.message} (lần ${st.errors}, thử lại sau ${this.errWaitSec()}s)`);
        if (this.trackError(e) !== 'ok') {
          this.log(`Lỗi lặp "${e.message}" → reset mềm, chờ ${CFG.REPEAT_START_WAIT_MS / 1000}s rồi đọc lại trạng thái.`);
          await sleepSlices(this.sleep, CFG.REPEAT_START_WAIT_MS, c.alive); return 'INIT';
        }
        try { // có thể đang kẹt trong trận cũ
          const cur = await api.towerState().catch(() => null);
          const run = cur && cur.run;
          if (run && run.monster && run.player) await this.fight(run, c.alive);
          else await this.sleep(this.errWaitMs());
        } catch (_) {}
        return 'DISPATCH';
      }
      return 'BATTLE';
    }

    async sBattle(c) {
      await this.fight(c.match, c.alive);
      return 'DISPATCH';
    }
  }
  TowerEngine.TRANSITIONS = {
    INIT: ['INIT', 'DISPATCH'], DISPATCH: ['DISPATCH', 'YIELD', 'MP_WAIT', 'START'], YIELD: ['DISPATCH'], MP_WAIT: ['DISPATCH'],
    START: ['DISPATCH', 'BATTLE', 'INIT'], BATTLE: ['DISPATCH'],
  };

  /* ---------------------------------------------------------------------
   *  LINH ĐIỀN: tự thu hoạch và trồng lại
   *  FSM: LOAD → (HARVEST) → (PLANT) → WAIT → LOAD ...
   *   - LOAD    : đọc linh điền + linh thạch (spirit_stones)
   *   - HARVEST : thu hoạch từng ô đã chín
   *   - PLANT   : trồng hạt đã chọn vào các ô trống, trong khả năng linh thạch
   *   - WAIT    : còn ô đang lớn → chờ (giây còn lại ngắn nhất + 60s); không có gì để chờ (hết linh thạch) → chờ 2 phút
   * --------------------------------------------------------------------- */
  class GardenEngine extends Engine {
    constructor(deps) {
      super(deps);
      Object.assign(this.st, { seedId: null, harvests: 0, stones: null, stonesOk: null, harvestOn: true, plantOn: true });
      this.machine = this.track(new StateMachine('garden', {
        LOAD: c => this.sLoad(c), HARVEST: c => this.sHarvest(c), PLANT: c => this.sPlant(c), WAIT: c => this.sWait(c),
      }, GardenEngine.TRANSITIONS));
    }
    get startMessage() { return 'BẮT ĐẦU tự động Linh Điền.'; }
    get stopMessage() { return 'ĐÃ DỪNG tự động Linh Điền.'; }
    execute(alive) { return this.machine.run('LOAD', { alive, state: null, waitMs: 0, waitText: '' }); }
    status(text) { this.emit('status', text); }
    setStones(have, need, ok, text) { Object.assign(this.st, { stones: have, stonesOk: ok }); this.emit('stones', { have, need, ok, text }); }
    static fmtDur(sec) { sec = Math.max(0, Math.ceil(sec)); const m = Math.floor(sec / 60), h = Math.floor(m / 60); return h ? `${h} giờ ${m % 60} phút` : m ? `${m} phút ${sec % 60} giây` : `${sec} giây`; }

    fail(e, label) {
      const { st } = this;
      st.errors++;
      this.log(`Lỗi ${label}: ${e.message} (lần ${st.errors}, thử lại sau ${this.errWaitSec()}s)`);
      return true;
    }
    seedOf(state) { return GardenCatalog.seeds(state).find(x => x.id === this.st.seedId) || null; }
    async readStones() { const me = await this.api.getMe(); return me && typeof me.spirit_stones === 'number' ? me.spirit_stones : null; }

    async sLoad(c) {
      if (!c.alive()) return null;
      const { st, api } = this;
      await this.yieldToBossFight(c.alive, 'Linh điền');
      if (!c.alive()) return null;
      if (st.plantOn && st.seedId == null) { await this.waitConfig(c.alive, 'Chưa chọn hạt giống để trồng'); return 'LOAD'; }
      try {
        c.state = await api.getGardenState();
        if (st.plantOn) { const stones = await this.readStones(); if (stones != null) st.stones = stones; }
        st.errors = 0;
      } catch (e) {
        if (!this.fail(e, 'đọc Linh Điền')) return null;
        await sleepSlices(this.sleep, this.errWaitMs(), c.alive);
        return 'LOAD';
      }
      const plots = GardenCatalog.plots(c.state), ready = GardenCatalog.ready(plots).length, left = GardenCatalog.minRemaining(plots);
      const growing = GardenCatalog.growing(plots).length, empty = GardenCatalog.empty(plots).length;
      const t = `Linh điền: ${ready} ô chín, ${growing} ô đang lớn${left != null ? ` (sớm nhất còn ${GardenEngine.fmtDur(left)})` : ''}, ${empty} ô trống.`;
      if (t !== c.lastInfo) { this.log(t); c.lastInfo = t; }
      return st.harvestOn && ready ? 'HARVEST' : 'PLANT';
    }

    async sHarvest(c) {
      const { st, api } = this;
      for (const p of GardenCatalog.ready(GardenCatalog.plots(c.state))) {
        if (!c.alive()) return null;
        if (!st.harvestOn) break; // tắt nút Thu hoạch giữa chừng: dừng thu hoạch ngay
        await this.yieldToBossFight(c.alive, 'Linh điền');
        if (!c.alive()) return null;
        try {
          const d = await api.gardenHarvest(p.slotIndex);
          st.harvests++; st.errors = 0; c.state = d || c.state;
          const h = d && d.lastHarvest;
          this.log(`Thu hoạch ô ${p.slotIndex}: ${h ? `${h.qty} ${h.herbName}` : (p.seed && p.seed.name) || 'ok'}`);
        } catch (e) {
          if (!this.fail(e, `thu hoạch ô ${p.slotIndex}`)) return null;
          await sleepSlices(this.sleep, this.errWaitMs(), c.alive);
          return 'LOAD';
        }
        await sleepSlices(this.sleep, CFG.GARDEN_CALL_GAP_MS, c.alive);
      }
      return 'PLANT';
    }

    async sPlant(c) {
      const { st, api } = this;
      let seed = null;
      if (st.plantOn) {
        const plots = GardenCatalog.plots(c.state), empties = GardenCatalog.empty(plots);
        seed = this.seedOf(c.state);
        if (!seed) { await this.waitConfig(c.alive, 'Hạt giống đã chọn không còn dùng được (bị khóa hoặc không có trong cửa hàng)'); return 'LOAD'; }
        if (empties.length) {
          let stones = st.stones, planted = 0;
          try { const fresh = await this.readStones(); if (fresh != null) stones = st.stones = fresh; } catch (_) {} // vừa thu hoạch xong: đọc lại cho chắc
          const afford = typeof stones === 'number' ? Math.floor(stones / seed.price) : empties.length; // không biết số dư thì cứ thử
          const todo = empties.slice(0, afford), need = empties.length * seed.price;
          if (typeof stones === 'number') {
            if (afford >= empties.length) this.setStones(stones, need, true, `✅ Đủ linh thạch: có ${stones.toLocaleString()}, cần ${need.toLocaleString()} cho ${empties.length} ô`);
            else {
              this.setStones(stones, need, false, `⚠ Không đủ linh thạch: có ${stones.toLocaleString()}, cần ${need.toLocaleString()} cho ${empties.length} ô (${seed.price.toLocaleString()}/ô)`);
              this.log(`Không đủ linh thạch để trồng ${empties.length} ô ${seed.name}: có ${stones.toLocaleString()}, cần ${need.toLocaleString()}${afford ? `. Chỉ trồng ${afford} ô.` : '.'}`);
            }
          }
          for (const p of todo) {
            if (!c.alive()) return null;
            if (!st.plantOn) break; // tắt nút Trồng thêm giữa chừng
            await this.yieldToBossFight(c.alive, 'Linh điền');
            if (!c.alive()) return null;
            try {
              const d = await api.gardenPlant(p.slotIndex, seed.id);
              c.state = d || c.state; planted++; st.errors = 0;
              if (typeof st.stones === 'number') st.stones -= seed.price;
            } catch (e) {
              if (/linh thạch|không đủ|not enough/i.test(e.message || '')) { // server từ chối vì thiếu linh thạch (số dư đọc được đã cũ)
                this.setStones(st.stones, need, false, `⚠ Không đủ linh thạch: ${e.message}`);
                this.log(`Không đủ linh thạch: ${e.message}`); break;
              }
              if (!this.fail(e, `trồng ô ${p.slotIndex}`)) return null;
              await sleepSlices(this.sleep, this.errWaitMs(), c.alive);
              return 'LOAD';
            }
            await sleepSlices(this.sleep, CFG.GARDEN_CALL_GAP_MS, c.alive);
          }
          if (planted) this.log(`Đã trồng ${planted}/${empties.length} ô ${seed.name}.`);
          try { const fresh = await this.readStones(); if (fresh != null) st.stones = fresh; } catch (_) {}
        }
      }
      // tính giờ quét lại từ trạng thái mới nhất
      const after = GardenCatalog.plots(c.state);
      const left = GardenCatalog.minRemaining(after), stillEmpty = GardenCatalog.empty(after).length, growing = GardenCatalog.growing(after).length;
      const poll = CFG.GARDEN_NOSTONE_POLL_MS;
      if (st.harvestOn && left != null) {
        c.waitMs = left * 1000 + CFG.GARDEN_EXTRA_WAIT_MS;
        c.waitText = `${growing} ô đang lớn, sớm nhất còn ${GardenEngine.fmtDur(left)} → chờ ${GardenEngine.fmtDur(c.waitMs / 1000)} (+${CFG.GARDEN_EXTRA_WAIT_MS / 1000}s) rồi thu hoạch${st.plantOn && stillEmpty ? `; còn ${stillEmpty} ô trống chưa trồng được` : ''}`;
      } else {
        c.waitMs = poll;
        c.waitText = !st.harvestOn && !st.plantOn ? `Cả Thu hoạch và Trồng thêm đang TẮT, kiểm tra lại sau ${poll / 60000} phút`
          : st.plantOn && stillEmpty ? `Chưa trồng được ${stillEmpty} ô, thử lại sau ${poll / 60000} phút`
          : !st.harvestOn && growing ? `${growing} ô đang lớn (Thu hoạch đang TẮT), kiểm tra lại sau ${poll / 60000} phút`
          : `Không có gì để làm, kiểm tra lại sau ${poll / 60000} phút`;
      }
      return 'WAIT';
    }

    async sWait(c) {
      const { st } = this; const id = st.seedId, h = st.harvestOn, p = st.plantOn;
      this.log(c.waitText + '.'); this.status(c.waitText);
      // đổi hạt / bật tắt Thu hoạch hoặc Trồng thêm → quét lại ngay
      await sleepSlices(this.sleep, c.waitMs, () => c.alive() && st.seedId === id && st.harvestOn === h && st.plantOn === p);
      return 'LOAD';
    }
  }
  GardenEngine.TRANSITIONS = { LOAD: ['LOAD', 'HARVEST', 'PLANT'], HARVEST: ['PLANT', 'LOAD'], PLANT: ['WAIT', 'LOAD'], WAIT: ['LOAD'] };

  /* ---------------------------------------------------------------------
   *  U MINH CỐC (bí cảnh mở vào đầu mỗi giờ, kéo dài 30 phút, bản đồ 11×11 sinh ngẫu nhiên mỗi phiên)
   *  FSM: WAIT_OPEN → ENTER → PLAY → (MOVE | FIGHT) → PLAY ... → END → WAIT_OPEN
   *   - WAIT_OPEN : hỏi trạng thái; chưa mở thì chờ tới đầu giờ kế tiếp; đã mở (và chưa làm xong phiên này) thì vào
   *   - ENTER     : chờ trận săn yêu / tầm bảo đang dở, chọn cổng (Bắc / Nam / Đông / Tây) rồi vào. Trọng thương thì chờ hồi.
   *   - PLAY      : còn sống? hết phiên? đang có trận? nhường boss; rồi tính bước đi kế tiếp
   *   - MOVE      : đợi >= 5s (và thời gian hồi của server) rồi đi 1 ô (gọi API di chuyển, tương đương bấm phím mũi tên)
   *   - FIGHT     : gặp quái thì đánh như tầm bảo / săn yêu (chọn chiêu khắc, đan hồi MP, chiêu hồi máu...)
   *   - END       : tổng kết phiên, nhả cờ ưu tiên
   *  Đường đi: không vào ô độc vụ / núi đá đã biết; đi về phía ô chưa mở khóa gần nhất (rương / Thú Đản chưa nhặt được ưu tiên), ngang nhau thì đi tiếp thẳng (quét liền mạch).
   *  Chọn cổng (Tự chọn): nhiều ô chưa mở nhất xung quanh cổng → nhiều ô chưa mở nhất trong bán kính 3 → ngẫu nhiên; vào lại sau khi gục thì tránh cổng vừa gục.
   *  Ô chưa mở thì không biết trước là gì (độc vụ vẫn có thể gục) → chết thì chờ hồi rồi vào lại, tối đa CFG.UM_MAX_DEATHS lần / phiên.
   * --------------------------------------------------------------------- */
  class UMinhEngine extends MatchEngine {
    constructor(deps) {
      super(deps);
      Object.assign(this.st, { spawn: 'auto' }); // 'auto' hoặc key cổng: top | bottom | left | right
      this.um = { offset: 0, open: false, session: null, me: null, grid: { size: 11, spawns: [], moveCooldownMs: 5000 }, cells: [] };
      this.flow = this.track(new StateMachine('uminh', {
        WAIT_OPEN: c => this.sWaitOpen(c), ENTER: c => this.sEnter(c), PLAY: c => this.sPlay(c),
        MOVE: c => this.sMove(c), FIGHT: c => this.sFight(c), END: c => this.sEnd(c),
      }, UMinhEngine.TRANSITIONS));
    }
    get hpKey() { return 'um'; }
    get modeName() { return 'U Minh Cốc'; }
    get minGapMs() { return CFG.UM_MIN_GAP_MS; } // mỗi lần đi / ra đòn cách nhau >= 1.8s (bước đi còn chờ nextMoveAt của server)
    get startMessage() { return 'BẮT ĐẦU auto U Minh Cốc (mở đầu mỗi giờ, kéo dài 30 phút).'; }
    get stopMessage() { return 'ĐÃ DỪNG auto U Minh Cốc.'; }
    releaseFlags() { this.coord.um = false; this.coord.umBattle = false; }
    // Còn phiên U Minh Cốc chưa đi xong? (xuất hồn chờ: đang đi, phiên đang mở mà chưa vào, hoặc chưa đọc được trạng thái lần nào)
    get sessionPending() {
      if (!this.st.running) return false;
      if (this.coord.um || !this.polled) return true;
      const s = this.um.session;
      return !!(this.um.open && s && this.serverNow() < s.endsAt && this.doneSessionId !== s.id);
    }
    // Game báo "U Minh Cốc đã đóng cửa" (ở bất kỳ bước nào): coi như hết phiên, không thử lại / không tính lỗi
    static isClosedError(e) { return /đã đóng cửa/i.test((e && e.message) || ''); }
    onClosedError(e) {
      if (!UMinhEngine.isClosedError(e)) return false;
      if (!this.closing) {
        this.closing = true;
        const um = this.um; if (um.session) um.session = { ...um.session, endsAt: Math.min(um.session.endsAt, this.serverNow()) };
        this.log('U Minh Cốc đã đóng cửa: kết thúc phiên này, chờ phiên đầu giờ sau.');
      }
      this.st.errors = 0; this.clearErrors();
      return true;
    }
    execute(alive) { this.polled = false; this.closing = false; return this.flow.run('WAIT_OPEN', { alive, deaths: 0, sessionId: null, doneSession: null, joinWait: 0, waitKey: null, boss: false, step: null, gateKey: null, lastDeadGate: null, lastDir: null }); }
    status(text) { this.emit('status', text); }

    /* --- trạng thái từ server --- */
    serverNow() { return this.now() + this.um.offset; }
    over() { const s = this.um.session; return !s || this.serverNow() >= s.endsAt; }
    applyState(s) {
      if (!s) return;
      const um = this.um; this.polled = true;
      if (typeof s.serverNow === 'number') um.offset = s.serverNow - this.now();
      if ('open' in s) um.open = !!s.open;
      if (s.session) um.session = { ...um.session, ...s.session };
      if ('me' in s) um.me = s.me || null;
      if (s.grid) um.grid = { ...um.grid, ...s.grid };
      if (typeof s.nextOpenAt === 'number') um.nextOpenAt = s.nextOpenAt;
      if (Array.isArray(s.cells) && s.cells.length) {
        um.cells = s.cells;
        const side = Math.round(Math.sqrt(s.cells.length)); // bản đồ 10×10 … 100×100: lưới vuông, kích thước lấy theo dữ liệu thật
        if (side * side === s.cells.length && um.grid.size !== side) um.grid = { ...um.grid, size: side };
      }
    }
    async doAction(body) { // trận kết thúc kèm `state` đầy đủ: cập nhật luôn, đỡ phải hỏi lại
      const r = await this.api.uminhAction(body);
      if (r && r.data && r.data.state) this.applyState(r.data.state);
      return r;
    }
    async fetchCurrent() { this.applyState(await this.api.uminhState()); return (this.um.me && this.um.me.battle) || null; }
    // Ô đi không được (vd. có người chơi khác đang ở đó): chỉ bỏ qua ở các lần chọn bước kế tiếp tới khi đi được một bước thành công, không chặn theo thời gian
    banCell(c, idx) { (c.skip = c.skip || new Set()).add(idx); }
    bannedCells(c) { return c.skip || new Set(); }
    onNoBattle() { return true; } // bật xử lý lỗi "Không có trận đấu nào đang diễn ra" trong MatchEngine.bAct
    onNonWin(c, d) { this.log(`Trận kết thúc với kết quả "${d.result}".`); return this.finish(c, d.result || 'lose'); }
    fail(e, label) {
      const { st } = this;
      st.errors++;
      this.log(`Lỗi ${label}: ${e.message} (lần ${st.errors}, thử lại sau ${this.errWaitSec()}s)`);
      return true;
    }

    async sWaitOpen(c) {
      if (!c.alive()) return null;
      const { st, um } = this;
      if (c.restUntil) { // đã hết phiên: không hỏi server nữa, ngủ thẳng tới đầu giờ sau
        const until = c.restUntil, text = `Hết phiên, nghỉ tới ${new Date(until - um.offset).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} (đầu giờ sau)`;
        this.status(text); this.log(text + '.');
        while (c.alive() && this.serverNow() < until + 1500) await this.sleep(Math.min(1000, Math.max(1, until + 1500 - this.serverNow())));
        if (!c.alive()) return null;
        c.restUntil = null;
      }
      try { this.applyState(await this.api.uminhState()); st.errors = 0; }
      catch (e) {
        if (!this.fail(e, 'đọc trạng thái U Minh Cốc')) return null;
        await sleepSlices(this.sleep, this.errWaitMs(), c.alive);
        return 'WAIT_OPEN';
      }
      const now = this.serverNow(), s = um.session;
      const inSession = um.open && s && now < s.endsAt;
      if (inSession && c.doneSession !== s.id) { this.status('Đang trong phiên U Minh Cốc'); return 'ENTER'; }
      let wait, key, text;
      if (inSession) { wait = s.endsAt - now; key = 'end' + s.id; text = 'Đã xong phiên này, chờ phiên kế tiếp'; }
      else {
        const next = (Math.floor(now / 3600000) + 1) * 3600000;
        wait = next - now; key = 'open' + next;
        const hhmm = new Date(next - um.offset).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        text = `Chưa mở. Lần mở kế tiếp: ${hhmm}`;
        if (wait > 0) text += ` (còn ${Math.ceil(wait / 60000)} phút)`;
      }
      this.status(text);
      if (c.waitKey !== key) { c.waitKey = key; this.log(text + '.'); }
      // chưa mở / đã xong phiên: ngủ thẳng tới mốc mở kế tiếp, KHÔNG quét server giữa chừng
      const target = inSession ? s.endsAt : (typeof um.nextOpenAt === 'number' && um.nextOpenAt > now ? um.nextOpenAt : now + wait);
      if (wait > 0) {
        while (c.alive() && this.serverNow() < target + 1500) await this.sleep(Math.min(1000, Math.max(1, target + 1500 - this.serverNow())));
      } else await sleepSlices(this.sleep, 5000, c.alive);
      return 'WAIT_OPEN';
    }

    async sEnter(c) {
      const { st, um, coord, api } = this;
      if (!c.alive()) return null;
      const s = um.session;
      if (this.over()) return 'END';
      if (c.sessionId !== s.id) { c.sessionId = s.id; c.deaths = 0; c.joinWait = 0; }
      if (this.bossWindow) { // 3 phút đầu giờ dành cho boss: chưa vào U Minh Cốc
        this.status('3 phút đầu giờ dành cho boss, chờ rồi mới vào U Minh Cốc'); this.log('3 phút đầu giờ dành cho boss: U Minh Cốc chờ rồi mới vào...');
        while (this.bossWindow && c.alive() && !this.over()) await this.sleep(1000);
        if (!c.alive()) return null;
        if (this.over()) return 'END';
      }
      const inside = !!(um.me && um.me.status === 'active'); // đang ở trong (vd. bật lại giữa phiên): không chặn
      if (!inside && (coord.boss || coord.bossPending)) { // còn boss và đang bật chế độ boss: không vào / không mở lượt mới (trong U Minh HP, MP không tự hồi theo thời gian nên hết đan là kẹt, đứng yên tới hết phiên)
        coord.um = false;
        this.status('Còn boss, chờ đánh xong rồi mới vào U Minh Cốc');
        this.log('Còn boss và đang bật chế độ boss: U Minh Cốc chờ, không vào / không mở lượt mới cho tới khi hết boss.');
        while ((coord.boss || coord.bossPending) && c.alive() && !this.over()) await this.sleep(1000);
        if (!c.alive()) return null;
        if (this.over()) return 'END';
        this.log('Hết boss: tiếp tục vào U Minh Cốc.');
      }
      if (!inside && this.api.getMe) { // trong U Minh Cốc HP, MP không tự hồi theo thời gian (đan vẫn dùng được): HP hoặc MP thấp thì hồi xong (đan hoặc chờ tự hồi ở ngoài) mới vào
        try { await this.refreshMe(); } catch (_) {}
        if (this.lowKinds().length) {
          coord.um = false;
          this.status('HP / MP thấp, hồi xong mới vào U Minh Cốc');
          if (!(await this.waitGate(c.alive, () => this.over()))) return c.alive() ? 'END' : null;
          return 'ENTER'; // kiểm tra lại boss / phiên trước khi vào
        }
      }
      coord.um = true; // từ đây săn yêu / tầm bảo không mở trận mới
      if (inside) return 'PLAY';
      if (c.deaths >= CFG.UM_MAX_DEATHS) { this.log(`Đã gục ${c.deaths} lần trong phiên này, bỏ qua phần còn lại của phiên.`); return 'END'; }
      while ((coord.farm || coord.hunt || coord.towerBattle) && c.alive() && !this.over()) await this.sleep(500); // đợi trận đang dở xong
      if (!c.alive()) return null;
      const gate = UMinhPlanner.chooseGate(um.cells, um.grid.size, um.grid.spawns, st.spawn, this.rand, c.lastDeadGate);
      if (!gate) { // không có cổng: không bỏ phiên, nhường chế độ khác rồi đọc lại bản đồ cho tới hết phiên
        coord.um = false;
        this.log(`Không tìm thấy cổng vào U Minh Cốc. Thử lại sau ${CFG.UM_NOGATE_WAIT_MS / 1000}s.`);
        await sleepSlices(this.sleep, CFG.UM_NOGATE_WAIT_MS, c.alive);
        try { this.applyState(await api.uminhState()); } catch (_) {}
        return 'ENTER';
      }
      try {
        const d = await api.uminhJoin(gate.key);
        st.errors = 0; this.healer.done(); this.applyState(d);
        c.gateKey = gate.key; c.lastDir = null;
        this.log(`Vào U Minh Cốc qua ${gate.label || gate.key}.`);
        return 'PLAY';
      } catch (e) {
        if (isInjuredError(e)) { // trọng thương (vd. vừa gục): chờ hồi máu rồi vào lại
          st.errors = 0;
          const r = await this.healer.step(c.alive, () => this.over());
          return r === 'retry' ? 'ENTER' : r === 'stopped' ? null : 'END';
        }
        if (/dang dở|đang dở|dở dang/i.test(e.message)) { // còn trận Tầm Bảo dở dang ở phía server
          st.errors = 0;
          if (c.joinWait++ % 10 === 0) this.log(`${e.message} Chờ hoàn thành, thử vào lại sau vài giây...`);
          await sleepSlices(this.sleep, 3000, c.alive);
          return 'ENTER';
        }
        if (await this.waitXuatHon(c.alive, e, true)) { st.errors = 0; return c.alive() ? 'ENTER' : null; } // đang xuất hồn: bỏ lượt (không chạy song song với U Minh Cốc) rồi vào
        if (this.onClosedError(e)) return 'END'; // đã đóng cửa: hết phiên
        if (!this.fail(e, 'vào U Minh Cốc')) return null;
        await sleepSlices(this.sleep, this.errWaitMs(), c.alive);
        return 'ENTER';
      }
    }

    async sPlay(c) {
      const { um, coord, api } = this;
      if (!c.alive()) return null;
      await this.skillGate(); // giữa hai bước / hai trận trong U Minh Cốc: đổi chiêu đang chờ
      if (this.over()) { this.log('Phiên U Minh Cốc đã kết thúc.'); return 'END'; }
      const me = um.me;
      if (!me || me.status !== 'active') {
        if (me && me.status === 'dead') { c.deaths++; c.lastDeadGate = c.gateKey; this.log(`Bị đẩy ra khỏi U Minh Cốc: ${me.deathReason || 'gục ngã'} (lần ${c.deaths}/${CFG.UM_MAX_DEATHS}).`); }
        else this.log(`Không còn ở trong U Minh Cốc (trạng thái: ${me ? me.status : 'chưa vào'}).`);
        coord.umBattle = false;
        return 'ENTER';
      }
      if (this.st.bagFull && !(await this.waitBag(c.alive))) return null; // túi đầy: không đánh / không đi tiếp
      if (me.battle) return 'FIGHT';
      while (this.bossWindow && c.alive() && !this.over()) await this.sleep(1000); // 3 phút đầu giờ: không đi / không mở trận mới
      while ((coord.boss || coord.bossPending) && c.alive() && !this.over()) { // ưu tiên boss: còn boss (đang bật chế độ boss) thì không đi / không mở lượt mới
        if (!c.boss) { this.log('Còn boss và đang bật chế độ boss, U Minh Cốc tạm nhường...'); c.boss = true; }
        await this.sleep(1000);
      }
      c.boss = false;
      if (!c.alive()) return null;
      const size = um.grid.size;
      const step = UMinhPlanner.nextStep(um.cells, size, me.pos, c.lastDir, this.bannedCells(c));
      if (!step && c.skip && c.skip.size) { // chỉ còn ô đang bị bỏ qua: bỏ danh sách đó, chờ chút rồi chọn lại (không tính là hết đường)
        c.skip = null; await sleepSlices(this.sleep, CFG.UM_BUSY_WAIT_MS, c.alive); try { this.applyState(await api.uminhState()); } catch (_) {}
        return 'PLAY';
      }
      if (!step) { // không còn ô nào để khám phá: kết thúc phiên luôn (rời U Minh Cốc, nghỉ tới phiên sau, nhường chế độ khác)
        this.log('Không còn ô nào đi tới được để khám phá: rời U Minh Cốc, kết thúc phiên này.');
        return 'END';
      }
      c.step = step;
      return 'MOVE';
    }

    async sMove(c) {
      const { st, um, api } = this; const step = c.step, size = um.grid.size;
      await this.waitGap(); // >= UM_MIN_GAP_MS kể từ lần đi / ra đòn trước (+ chút ngẫu nhiên)
      const cd = ((um.me && um.me.nextMoveAt) || 0) - this.serverNow(); // thời gian hồi di chuyển của server
      if (cd > 0) await sleepSlices(this.sleep, cd + 300, c.alive);
      if (!c.alive()) return null;
      if (this.over()) return 'END';
      this.markAttack();
      try {
        const d = await api.uminhMove(step.dir);
        c.lastDir = step.dir; c.busyMoves = 0; c.skip = null; this.clearErrors();
        st.errors = 0; this.healer.done(); this.applyState(d);
        const o = d && d.outcome;
        this.log(`Đi ${UMinhPlanner.DIR_NAME[step.dir]} → (${UMinhPlanner.label(step.next, size)}): ${o && o.message ? o.message : 'ok'}`);
      } catch (e) {
        if (/quá nhanh|too fast/i.test(e.message)) { await sleepSlices(this.sleep, 2000, c.alive); return 'PLAY'; }
        // "… đang giao chiến với yêu thú ở ô này, hãy chờ chút": ô đó đang có trận (bạn đánh tay / trận chưa đồng bộ) → không tính là lỗi,
        // đọc lại trạng thái (có trận thì sang FIGHT), chờ rồi đi tiếp. Quá UM_BUSY_MAX lần liên tiếp mới coi là lỗi.
        if (/giao chiến|hãy chờ chút/i.test(e.message) && (c.busyMoves = (c.busyMoves || 0) + 1) <= CFG.UM_BUSY_MAX) {
          st.errors = 0; this.banCell(c, step.next); // ô có người chơi khác đang giao chiến: đi hướng khác
          if (c.busyMoves === 1 || c.busyMoves % 10 === 0) this.log(`Ô này đang có trận (${e.message}). Bỏ qua ô ${UMinhPlanner.label(step.next, size)}, đi hướng khác (lần ${c.busyMoves}).`);
          try { this.applyState(await api.uminhState()); } catch (_) {}
          await sleepSlices(this.sleep, CFG.UM_BUSY_WAIT_MS, c.alive);
          return 'PLAY';
        }
        if (isInjuredError(e)) { // không đi được vì trọng thương
          st.errors = 0;
          const r = await this.healer.step(c.alive, () => this.over());
          return r === 'retry' ? 'PLAY' : r === 'stopped' ? null : 'END';
        }
        if (this.onClosedError(e)) return 'END'; // đã đóng cửa: hết phiên
        this.banCell(c, step.next);
        if (this.trackError(e) !== 'ok') this.log(`Lỗi lặp khi đi "${e.message}": bỏ qua ô ${UMinhPlanner.label(step.next, size)}, đi hướng khác.`);
        if (!this.fail(e, 'di chuyển')) return null;
        await sleepSlices(this.sleep, this.errWaitMs(), c.alive);
        try { this.applyState(await api.uminhState()); } catch (_) {} // đồng bộ lại vị trí
      }
      return 'PLAY';
    }

    async sFight(c) {
      const { st, coord, api } = this;
      coord.umBattle = true; // boss chờ trận này xong
      let result;
      try { result = await this.fightMatch(this.um.me.battle, c.alive); }
      finally { coord.umBattle = false; }
      if (!c.alive()) return null;
      if (result === 'closed') return 'END'; // game báo đã đóng cửa giữa trận
      if (result === 'nobattle') { // server báo không có trận: có thể bạn đã đánh tay. Quét lại tối đa 3 lần rồi đi tiếp.
        c.noBattle = (c.noBattle || 0) + 1;
        this.log(`Server báo không có trận đấu nào đang diễn ra (quét ${c.noBattle}/${CFG.UM_NOBATTLE_SCANS}).`);
        try { this.applyState(await api.uminhState()); } catch (_) {}
        if (c.noBattle >= CFG.UM_NOBATTLE_SCANS || !(this.um.me && this.um.me.battle)) {
          if (this.um.me && this.um.me.battle) { this.log('Vẫn còn dữ liệu trận cũ nhưng không đánh được, bỏ qua và đi tiếp (có thể bạn đã đánh tay).'); this.um.me = { ...this.um.me, battle: null }; }
          c.noBattle = 0;
        }
        return 'PLAY';
      }
      c.noBattle = 0;
      if (result !== 'win') { // thua / lỗi: đọc lại trạng thái thật từ server
        try { this.applyState(await api.uminhState()); } catch (_) {}
        if (result === 'error') { st.errors = 0; await sleepSlices(this.sleep, this.errWaitMs(), c.alive); }
      }
      return 'PLAY';
    }

    async sEnd(c) {
      const { um, coord } = this;
      coord.um = false; coord.umBattle = false;
      const closing = this.closing; this.closing = false;
      if ((!this.over() || closing) && um.me && um.me.status === 'active') { // còn trong phiên mà bỏ cuộc: rời U Minh Cốc, không thì tầm bảo / săn yêu bị chặn
        try { this.applyState(await this.api.uminhLeave()); this.log('Đã rời U Minh Cốc.'); }
        catch (e) { if (!closing) this.log(`Không rời được U Minh Cốc: ${e.message}`); } // đã đóng cửa mà game từ chối: bỏ qua, không báo lỗi
      }
      const s = um.session, me = um.me;
      if (s) { c.doneSession = this.doneSessionId = s.id; c.restUntil = (Math.floor(Math.max(s.endsAt, this.serverNow()) / 3600000) + 1) * 3600000; }
      if (me) this.log(`Tổng kết phiên: ${me.steps ?? 0} bước, hạ ${me.kills ?? 0} quái, mở ${me.chests ?? 0} rương, +${me.expGained ?? 0} tu vi, +${me.lockedStonesGained ?? 0} linh thạch khóa.`);
      return 'WAIT_OPEN';
    }
  }
  UMinhEngine.TRANSITIONS = {
    WAIT_OPEN: ['WAIT_OPEN', 'ENTER'], ENTER: ['ENTER', 'PLAY', 'END'], PLAY: ['PLAY', 'ENTER', 'FIGHT', 'MOVE', 'END'],
    MOVE: ['PLAY', 'END'], FIGHT: ['PLAY', 'END'], END: ['WAIT_OPEN'],
  };

  /* ---------------------------------------------------------------------
   *  TỰ ĐĂNG NHẬP
   *  FSM: idle → wait (đã điền form, chờ nút "Đăng Nhập" sáng = Turnstile của trang đã cấp mã) → sent (đã bấm) → idle | cool
   *  Không gọi API đăng nhập trực tiếp và không đụng tới Turnstile: chỉ thao tác trên form của chính trang game.
   * --------------------------------------------------------------------- */
  class AutoLogin extends EventEmitter {
    constructor(deps = {}) {
      super();
      this.now = deps.now || (() => Date.now());
      this.doc = deps.doc || null; // mặc định: document hiện tại
      this.cfg = { enabled: false, user: '', pass: '' };
      this.state = 'idle'; this.t0 = 0; this.fails = 0; this.coolUntil = 0; this.hinted = false; this.running = false;
    }
    log(m) { this.emit('log', m); }
    status(t, kind) { this.emit('status', t, kind); }
    configure(c) {
      const was = this.cfg.enabled;
      Object.assign(this.cfg, c);
      if (this.cfg.enabled && !was) { this.fails = 0; this.state = 'idle'; this.coolUntil = 0; }
      if (!this.cfg.enabled) { this.state = 'idle'; this.status(''); }
    }
    get ready() { return this.cfg.enabled && !!this.cfg.user && !!this.cfg.pass; }
    // tìm form ĐĂNG NHẬP của game (bỏ qua form đăng ký: có ô email; form đổi mật khẩu: không có ô tên đăng nhập)
    static find(doc) {
      doc = doc || document;
      for (const pw of doc.querySelectorAll('input[type="password"][autocomplete="current-password"]')) {
        if (pw.closest('#tt-auto-boss-panel')) continue;
        const form = pw.closest('form'); if (!form || form.querySelector('input[type="email"]')) continue;
        const user = form.querySelector('input[autocomplete="username"]'); if (!user) continue;
        const btn = [...form.querySelectorAll('button[type="submit"]')].find(b => /đăng\s*nhập/i.test(b.textContent)) || null;
        if (btn) return { form, user, pw, btn };
      }
      return null;
    }
    // đặt giá trị cho ô nhập do React quản lý (gán qua setter gốc rồi phát sự kiện input)
    static setValue(input, value) {
      if (input.value === value) return;
      const win = input.ownerDocument.defaultView;
      const desc = Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, 'value');
      desc.set.call(input, value);
      input.dispatchEvent(new win.Event('input', { bubbles: true }));
    }
    static errorText(form) { const e = form.querySelector('.form-error'); return e ? e.textContent.replace(/^\s*⚠️?\s*/, '').trim() : ''; }

    fillAll(f) { AutoLogin.setValue(f.user, this.cfg.user); AutoLogin.setValue(f.pw, this.cfg.pass); }
    fail(why) {
      this.fails++;
      this.log(`Đăng nhập chưa được${why ? ': ' + why : ''} (${this.fails}/${CFG.LOGIN_MAX_FAILS}).`);
      if (this.fails >= CFG.LOGIN_MAX_FAILS) {
        this.cfg.enabled = false; this.state = 'idle';
        this.log('Thất bại liên tiếp nhiều lần, tự tắt tự đăng nhập để không bị khóa tài khoản. Kiểm tra tên / mật khẩu rồi bật lại.');
        this.status('Đã tắt sau nhiều lần thất bại', 'err'); this.emit('disabled');
        return;
      }
      this.state = 'cool'; this.coolUntil = this.now() + CFG.LOGIN_RETRY_MS;
    }
    // gọi định kỳ (mỗi giây)
    step() {
      if (this.running) return; this.running = true;
      try { this.tick(); } finally { this.running = false; }
    }
    tick() {
      if (!this.ready) { if (this.cfg.enabled && this.state === 'idle') this.status('Chưa nhập tên đăng nhập / mật khẩu', 'err'); return; }
      const f = AutoLogin.find(this.doc), now = this.now();
      if (this.state === 'cool') { if (now < this.coolUntil) return; this.state = 'idle'; }
      if (this.state === 'idle') {
        if (!f) { this.status('Đang chờ màn hình đăng nhập'); return; }
        this.fillAll(f); this.state = 'wait'; this.t0 = now; this.hinted = false;
        this.log('Thấy màn hình đăng nhập: đã điền tên + mật khẩu, chờ Cloudflare xác minh...');
        this.status('Đã điền, chờ xác minh Cloudflare...');
        return;
      }
      if (this.state === 'wait') {
        if (!f) { this.state = 'idle'; return; }
        this.fillAll(f); // form được vẽ lại thì điền lại
        if (!f.btn.disabled) {
          f.btn.click(); this.state = 'sent'; this.t0 = now;
          this.log('Đã bấm "Đăng Nhập".'); this.status('Đã gửi đăng nhập...');
        } else if (now - this.t0 > CFG.LOGIN_HINT_MS && !this.hinted) {
          this.hinted = true;
          this.log('Cloudflare chưa cấp mã xác minh. Nếu thấy ô xác minh trên màn hình đăng nhập, hãy tự tick vào đó; tool sẽ bấm "Đăng Nhập" ngay khi nút sáng.');
          this.status('Chờ bạn xác minh Cloudflare (nếu có ô tick)', 'warn');
        } else if (now - this.t0 > CFG.LOGIN_WAIT_MS) {
          this.log('Chờ quá lâu mà Cloudflare chưa cấp mã, sẽ thử lại.'); this.state = 'cool'; this.coolUntil = now + CFG.LOGIN_RETRY_MS;
        }
        return;
      }
      if (this.state === 'sent') {
        if (!f) { this.fails = 0; this.state = 'idle'; this.log('Đăng nhập xong.'); this.status('Đã đăng nhập'); this.emit('done'); return; }
        const err = AutoLogin.errorText(f.form);
        if (err) { this.fail(err); return; }
        if (now - this.t0 > CFG.LOGIN_SENT_MS) this.fail('trang không phản hồi');
      }
    }
  }

  /* ---------------------------------------------------------------------
   *  XUẤT HỒN: chọn bản đồ (10 map ứng với 10 cảnh giới) + thời gian (5 / 10 / 20 / 60 phút), game tính giờ phía server
   *  XuatHonCatalog (domain): chọn map (mặc định: map cao nhất đã mở khóa), luật "còn ít phút tới đầu giờ thì không bắt đầu"
   *  XuatHonEngine FSM: LOAD → DECIDE → START → RUN → CLAIM → DECIDE ...
   *   - LOAD    : đọc trạng thái; có lượt đang chạy / đã xong chưa nhận thì nhận vào (RUN)
   *   - DECIDE  : chờ tới khi U Minh Cốc đã đi xong (hoặc tắt) và tầm bảo hết vé (hoặc tắt); còn < max(5, mức đã chọn) phút tới đầu giờ thì nghỉ tới đầu giờ sau
   *   - RUN     : chờ hết giờ (đọc lại trạng thái mỗi 30s) → CLAIM nhận thưởng → DECIDE (kiểm tra giờ rồi mới lượt kế)
   *  Không đụng tới boss / săn yêu / leo tháp. Tầm bảo / U Minh Cốc gặp lỗi do đang xuất hồn thì tự chờ (Engine.waitXuatHon).
   * --------------------------------------------------------------------- */
  class XuatHonCatalog {
    static unlocked(maps) { return (maps || []).filter(m => m && !m.locked); }
    static best(maps) { return XuatHonCatalog.unlocked(maps).reduce((b, m) => (!b || (m.minRealmTier || 0) > (b.minRealmTier || 0) ? m : b), null); }
    // sel = 'auto' (hoặc trống) → map cao nhất đã mở khóa; map đã chọn mà đang khóa → cũng về map cao nhất
    static pick(maps, sel) { const f = sel && sel !== 'auto' ? (maps || []).find(m => m.code === sel && !m.locked) : null; return f || XuatHonCatalog.best(maps); }
    static threshold(dur) { return Math.max(CFG.XH_MIN_BEFORE_HOUR_MIN, Number(dur) || 0); }
    static minutesToHour(nowMs) { return (3600000 - (((nowMs % 3600000) + 3600000) % 3600000)) / 60000; }
    static canStart(nowMs, dur) { return XuatHonCatalog.minutesToHour(nowMs) >= XuatHonCatalog.threshold(dur) - 1e-9; }
    static reward(m, dur) { const r = m && m.rewardsByDuration && m.rewardsByDuration[String(dur)]; return r ? { exp: r.exp, stones: r.lockedSpiritStones } : null; }
  }
  XuatHonCatalog.DURATIONS = [5, 10, 20, 60];

  class XuatHonEngine extends Engine {
    constructor(deps) {
      super(deps);
      Object.assign(this.st, { mapSel: 'auto', duration: CFG.XH_DEFAULT_DURATION, maps: null, durations: XuatHonCatalog.DURATIONS, mapsAt: 0, ver: 0 });
      this.blockers = deps.blockers || (() => ''); // trả lý do đang bị chặn (chuỗi) hoặc '' nếu được chạy
      this.machine = this.track(new StateMachine('xuathon', {
        LOAD: c => this.sLoad(c), DECIDE: c => this.sDecide(c), START: c => this.sStart(c), RUN: c => this.sRun(c), CLAIM: c => this.sClaim(c),
      }, XuatHonEngine.TRANSITIONS));
    }
    get startMessage() { return 'BẮT ĐẦU tự động xuất hồn.'; }
    get stopMessage() { return 'ĐÃ DỪNG tự động xuất hồn (lượt đang chạy, nếu có, vẫn chạy tiếp ở server; tầm bảo / U Minh Cốc sẽ tự chờ và nhận thưởng khi cần).'; }
    execute(alive) { return this.machine.run('LOAD', { alive, run: null, reason: null, timeKey: null, map: null, dur: null }); }
    status(text) { this.emit('status', text); }
    fail(e, label) {
      const { st } = this;
      st.errors++;
      this.log(`Lỗi ${label}: ${e.message} (lần ${st.errors}, thử lại sau ${this.errWaitSec()}s)`);
    }
    async loadOptions(force) {
      const { st, api } = this;
      if (!force && st.maps && this.now() - st.mapsAt < CFG.XH_OPTIONS_TTL_MS) return st.maps;
      const d = await api.xhOptions();
      if (d && Array.isArray(d.maps)) {
        st.maps = d.maps; st.mapsAt = this.now();
        if (Array.isArray(d.durations) && d.durations.length) st.durations = d.durations.map(Number);
        this.emit('maps', st.maps, st.durations);
      }
      return st.maps;
    }

    async sLoad(c) {
      if (!c.alive()) return null;
      try {
        const s = await this.api.xhStatus(); this.st.errors = 0;
        if (s) {
          c.run = s;
          this.log(s.ready ? 'Có lượt xuất hồn đã xong mà chưa nhận, nhận thưởng.' : `Có lượt xuất hồn đang chạy${s.dungeonName ? ` (${s.dungeonName})` : ''}, còn ${fmtSec(s.secondsRemaining)}: chờ xong rồi nhận thưởng.`);
          return 'RUN';
        }
        return 'DECIDE';
      } catch (e) {
        this.fail(e, 'đọc trạng thái xuất hồn');
        await sleepSlices(this.sleep, this.errWaitMs(), c.alive);
        return 'LOAD';
      }
    }

    async sDecide(c) {
      const { st } = this;
      if (!c.alive()) return null;
      let maps;
      try { maps = await this.loadOptions(false); st.errors = 0; }
      catch (e) { this.fail(e, 'đọc danh sách bản đồ xuất hồn'); await sleepSlices(this.sleep, this.errWaitMs(), c.alive); return 'DECIDE'; }
      const m = XuatHonCatalog.pick(maps, st.mapSel);
      if (!m) { await this.waitConfig(c.alive, 'Chưa có bản đồ xuất hồn nào mở khóa'); return 'DECIDE'; }
      const dur = st.durations.includes(st.duration) ? st.duration : CFG.XH_DEFAULT_DURATION;
      c.map = m; c.dur = dur;
      const ver = st.ver, same = () => c.alive() && st.ver === ver; // đổi map / thời gian trên giao diện → quyết định lại ngay
      const why = this.blockers();
      if (why) {
        this.status(`Chờ: ${why}`);
        if (c.reason !== why) { c.reason = why; this.log(`Chưa xuất hồn: ${why}. Kiểm tra lại mỗi ${CFG.XH_IDLE_MS / 1000}s.`); }
        await sleepSlices(this.sleep, CFG.XH_IDLE_MS, same);
        return 'DECIDE';
      }
      c.reason = null;
      const now = this.now();
      if (!XuatHonCatalog.canStart(now, dur)) {
        const next = (Math.floor(now / 3600000) + 1) * 3600000, left = Math.max(0, Math.floor(XuatHonCatalog.minutesToHour(now)));
        const text = `Còn ${left} phút tới đầu giờ (cần từ ${XuatHonCatalog.threshold(dur)} phút), nghỉ tới ${new Date(next).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
        this.status(text);
        if (c.timeKey !== next) { c.timeKey = next; this.log(`${text}.`); }
        await sleepSlices(this.sleep, next + CFG.XH_HOUR_MARGIN_MS - now, same);
        return 'DECIDE';
      }
      return 'START';
    }

    async sStart(c) {
      const { st, api } = this;
      if (!c.alive()) return null;
      try {
        const d = await api.xhStart(c.map.code, c.dur);
        st.errors = 0; this.clearErrors(); c.run = d;
        const r = XuatHonCatalog.reward(c.map, c.dur);
        this.log(`BẮT ĐẦU xuất hồn ${(d && d.dungeonName) || c.map.name}, ${c.dur} phút${r ? ` (dự kiến +${(d && d.expReward) || r.exp} tu vi, +${(d && d.lockedSpiritStonesReward) || r.stones} linh thạch khóa)` : ''}.`);
        return 'RUN';
      } catch (e) {
        let s = null; try { s = await api.xhStatus(); } catch (_) {}
        if (s) return 'LOAD'; // thật ra đã có lượt đang chạy: nhận vào
        this.fail(e, 'bắt đầu xuất hồn');
        await sleepSlices(this.sleep, this.errWaitMs(), c.alive);
        return 'DECIDE';
      }
    }

    async sRun(c) {
      const { st, api } = this;
      let s = c.run;
      while (c.alive()) {
        if (s && s.ready) return 'CLAIM';
        const remain = s && Number.isFinite(Number(s.secondsRemaining)) ? Number(s.secondsRemaining) : 0;
        this.status(`Đang xuất hồn${s && s.dungeonName ? ` ${s.dungeonName}` : ''}, còn ${fmtSec(remain)}`);
        await sleepSlices(this.sleep, remain > 0 ? Math.min(CFG.XH_POLL_MS, remain * 1000 + CFG.XH_CLAIM_MARGIN_MS) : CFG.XH_POLL_MS, c.alive);
        if (!c.alive()) return null;
        try { s = await api.xhStatus(); st.errors = 0; }
        catch (e) { this.fail(e, 'đọc trạng thái xuất hồn'); await sleepSlices(this.sleep, this.errWaitMs(), c.alive); continue; }
        if (!s) { this.log('Lượt xuất hồn đã kết thúc (không còn trạng thái ở server).'); return 'DECIDE'; }
      }
      return null;
    }

    async sClaim(c) {
      const { st, api } = this;
      if (!c.alive()) return null;
      try {
        const d = await api.xhClaim(); st.errors = 0;
        this.log(`Hoàn thành xuất hồn${d && d.dungeonName ? ` ${d.dungeonName}` : ''}, nhận được +${(d && d.expGained) || 0} tu vi, +${(d && d.lockedSpiritStonesGained) || 0} linh thạch khóa.`);
        return 'DECIDE';
      } catch (e) {
        let s = null; try { s = await api.xhStatus(); } catch (_) {}
        if (!s) return 'DECIDE'; // đã được nhận ở nơi khác (vd. tầm bảo / U Minh Cốc đang chờ)
        this.fail(e, 'nhận thưởng xuất hồn');
        await sleepSlices(this.sleep, this.errWaitMs(), c.alive);
        return 'CLAIM';
      }
    }
  }
  XuatHonEngine.TRANSITIONS = { LOAD: ['LOAD', 'RUN', 'DECIDE'], DECIDE: ['DECIDE', 'START'], START: ['RUN', 'LOAD', 'DECIDE'], RUN: ['CLAIM', 'DECIDE'], CLAIM: ['DECIDE', 'CLAIM'] };

  /* ---------------------------------------------------------------------
   *  TÔNG CHIẾN (trận mô phỏng, không mất HP thật)
   *  Vòng đời một ngày: chờ tới gatherAt → đổi chiêu → vào lãnh địa (garrison; server chụp bộ chiêu) → trong khung live đánh:
   *    người chơi tông khác (power <= WAR_MAX_POWER, không giới hạn lượt) > thủ vệ (tối đa 5 lần thắng) > chờ người chơi xuất hiện.
   *  Một lượt đánh = POST attack (mở trận) rồi POST match/action lặp tới khi finished. Dừng khi hết giờ live hoặc đủ lượt tối đa của server.
   * --------------------------------------------------------------------- */
  class WarCatalog {
    static RING = { outer: 0, middle: 1, center: 2 };
    static ringRank(t) { const r = WarCatalog.RING[t && t.ring]; return r == null ? -1 : r; }
    // Lãnh địa tông của mình đã đăng ký (được duyệt), giữ thứ tự của server
    static mine(ov) {
      const id = ov && ov.me && ov.me.sect && ov.me.sect.id;
      if (id == null) return [];
      return (ov.territories || []).filter(t => (t.registrations || []).some(r => r.sectId === id && (r.status == null || r.status === 'admitted')));
    }
    // Mặc định: vòng cao hơn trước (outer < middle < center); bằng nhau thì cái đứng trước trong danh sách của server
    static pickDefault(list) {
      let best = null;
      for (const t of list || []) if (!best || WarCatalog.ringRank(t) > WarCatalog.ringRank(best)) best = t;
      return best;
    }
    // Lựa chọn tay hết hạn lúc 20:55 (giờ máy) hôm nay; đã qua 20:55 thì 20:55 ngày mai
    static expiryAfter(now) {
      const d = new Date(now); d.setHours(20, 55, 0, 0);
      if (d.getTime() <= now) d.setDate(d.getDate() + 1);
      return d.getTime();
    }
    // Lần quét lãnh địa kế tiếp: xx:25
    static nextScan(now) {
      const d = new Date(now); d.setMinutes(25, 0, 0);
      if (d.getTime() <= now) d.setHours(d.getHours() + 1);
      return d.getTime();
    }
    // Người chơi đánh được: khác tông mình, power <= maxPower, chưa bị đánh dấu bỏ qua. Yếu nhất trước.
    static pickPlayers(targets, mySectId, maxPower, skipped) {
      return (targets || []).filter(t => t && t.characterId != null && t.sectId !== mySectId && !(Number(t.power) > maxPower) && !(skipped && skipped(t.characterId)))
        .sort((a, b) => (Number(a.power) || 0) - (Number(b.power) || 0));
    }
    // ISO | epoch ms | null → epoch ms (0 nếu không có)
    static ts(v) { if (v == null) return 0; const n = typeof v === 'number' ? v : Date.parse(v); return Number.isFinite(n) ? n : 0; }
    // Chiêu trong trận Tông Chiến có dạng effects[]; chuyển sang dạng SkillSelector đọc (damage_multiplier)
    static skill(s) {
      const main = (Array.isArray(s.effects) ? s.effects : []).find(e => e && (e.type === 'damage' || e.type === 'heal')) || {};
      return { ...s, damage_multiplier: main.mult != null ? main.mult : (main.pct != null ? main.pct : 0) };
    }
  }

  class WarEngine extends Engine {
    constructor(deps) {
      super(deps);
      Object.assign(this.st, {
        choice: null, territory: null, options: [], scanAt: 0, offset: 0, day: null, sectId: null, sectName: '', maxPower: CFG.WAR_MAX_POWER, maxAttacks: 40,
        attacks: 0, wins: 0, losses: 0, guardWins: 0, points: 0, cp: 0, nextAt: 0, woundedUntil: 0, swapDay: null, doneDay: null, skips: new Map(), enteredDay: null,
      });
    }
    get startMessage() { return 'BẮT ĐẦU Tông Chiến: chỉ hành động trong khung giờ sự kiện.'; }
    get stopMessage() { return 'ĐÃ DỪNG Tông Chiến.'; }
    get minGapMs() { return CFG.WAR_MIN_GAP_MS; }
    status(t) { this.emit('status', t); }
    srvNow() { return this.now() + this.st.offset; }
    terrName(code) { const t = (this.st.options || []).find(x => x.code === code) || ((this.st.ov && this.st.ov.territories) || []).find(x => x.code === code); return t ? t.name : (code || ''); }
    summary() {
      const st = this.st;
      return `${st.sectName || '?'} · ${st.territory ? this.terrName(st.territory) : 'chưa có lãnh địa'} · lượt ${st.attacks}/${st.maxAttacks} · thắng ${st.wins} · điểm ${st.points} · cp ${st.cp}`;
    }
    info() { this.emit('info', this.summary()); }
    releaseFlags() { this.st.skips.clear(); }

    // Chọn lãnh địa tay (null = tự chọn). Giữ tới 20:55; các lần quét sau không ghi đè trong thời gian đó.
    setChoice(code) {
      const st = this.st;
      st.choice = code ? { code, until: WarCatalog.expiryAfter(this.now()) } : null;
      st.scanAt = 0;
      this.emit('choice', st.choice);
      if (code) this.log(`Chọn lãnh địa ${this.terrName(code)}: giữ tới ${new Date(st.choice.until).toLocaleString([], { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' })}.`);
      else this.log('Về chế độ tự chọn lãnh địa (vòng cao trước).');
    }

    async fail(e, label, alive) {
      const st = this.st; st.errors++;
      this.log(`Lỗi ${label}: ${e.message} (lần ${st.errors}, thử lại sau ${this.errWaitSec()}s)`);
      await sleepSlices(this.sleep, this.errWaitMs(), alive);
    }

    // Chờ tới mốc `at` (giờ server) nhưng tối đa maxMs; mỗi giây cập nhật dòng trạng thái
    async waitUntil(alive, at, label, maxMs = CFG.WAR_IDLE_POLL_MS) {
      const end = Math.min(at, this.srvNow() + maxMs);
      while (alive() && this.srvNow() < end) {
        this.status(`${label} (còn ${fmtSec((at - this.srvNow()) / 1000)})`);
        await this.sleep(Math.min(1000, Math.max(50, end - this.srvNow())));
      }
    }

    syncGarrison(g) {
      const st = this.st;
      if (!g) { Object.assign(st, { attacks: 0, wins: 0, losses: 0, guardWins: 0, points: 0, cp: 0, nextAt: 0, woundedUntil: 0 }); return; }
      Object.assign(st, {
        attacks: Number(g.attacksMade) || 0, wins: Number(g.wins) || 0, losses: Number(g.losses) || 0, guardWins: Number(g.guardWins) || 0,
        points: Number(g.pointsEarned) || 0, cp: Number(g.cpContrib) || 0, nextAt: WarCatalog.ts(g.nextActionAt), woundedUntil: WarCatalog.ts(g.woundedUntil),
      });
    }

    async loadOverview() {
      const st = this.st, ov = await this.api.warOverview();
      if (!ov || typeof ov !== 'object') throw new Error('Phản hồi Tông Chiến không hợp lệ');
      if (typeof ov.serverNow === 'number') st.offset = ov.serverNow - this.now();
      st.ov = ov; st.day = ov.day || null;
      st.maxAttacks = ov.limits && ov.limits.maxAttacks > 0 ? ov.limits.maxAttacks : 40;
      st.sectId = ov.me && ov.me.sect ? ov.me.sect.id : null; st.sectName = ov.me && ov.me.sect ? ov.me.sect.name : '';
      this.syncGarrison(ov.me && ov.me.garrison);
      return ov;
    }

    // Quét lãnh địa của tông: khi vừa bật và mỗi giờ lúc xx:25 (hoặc ngay sau khi đổi lựa chọn)
    scan(ov) {
      const st = this.st, now = this.now();
      if (now < st.scanAt) return;
      st.scanAt = WarCatalog.nextScan(now);
      const list = WarCatalog.mine(ov);
      st.options = list;
      if (st.choice && now >= st.choice.until) { st.choice = null; this.emit('choice', null); this.log('Lựa chọn lãnh địa đã hết hạn (20:55), về chế độ tự chọn.'); }
      const mine = st.choice && list.find(t => t.code === st.choice.code);
      const pick = mine || WarCatalog.pickDefault(list);
      const code = pick ? pick.code : null;
      if (code !== st.territory) this.log(code ? `Lãnh địa chiếm: ${pick.name} (${pick.ringLabel || pick.ring})${mine ? ' [bạn chọn]' : ''}.` : 'Tông chưa đăng ký lãnh địa nào được duyệt.');
      st.territory = code;
      this.emit('territories', list, code, !!mine);
    }

    // Đổi chiêu (một lần mỗi ngày) rồi vào lãnh địa. true = đã vào (hoặc đã ở trong lãnh địa), false = chưa vào được
    async enter(ov, alive) {
      const st = this.st, day = ov.day, g = ov.me.garrison;
      if (g && g.territoryCode) {
        if (st.territory !== g.territoryCode) { st.territory = g.territoryCode; this.emit('territories', st.options, st.territory, true); }
        return true;
      }
      if (!st.territory) {
        if (st.noTerrDay !== day.key) { st.noTerrDay = day.key; this.log('Tông chưa đăng ký lãnh địa nào được duyệt nên không vào được Tông Chiến hôm nay.'); }
        this.status('Tông chưa đăng ký lãnh địa nào được duyệt'); await sleepSlices(this.sleep, 60000, alive); return false;
      }
      if (this.swapper && st.swapDay !== day.key) {
        for (let i = 0; i < 3 && alive(); i++) {
          if ((await this.swapper.ensureWar('Tông Chiến')) !== 'error') break;
          if (i === 2) this.log('Không đổi được chiêu, vẫn vào bằng bộ chiêu hiện tại.');
          else await sleepSlices(this.sleep, 2000, alive);
        }
        st.swapDay = day.key;
      }
      if (!alive()) return false;
      try {
        const d = await this.api.warGarrison(st.territory);
        st.errors = 0; this.clearErrors(); st.enteredDay = day.key;
        this.log(`Đã vào ${this.terrName(st.territory)}${d && d.power ? `, lực chiến ${d.power}` : ''}.`);
        return true;
      } catch (e) {
        if (this.srvNow() < day.liveStartAt) { // chưa tới giờ live: server có thể chưa cho vào, chờ rồi thử lại
          this.log(`Chưa vào được lãnh địa (${e.message}), thử lại khi bắt đầu live.`);
          await this.waitUntil(alive, day.liveStartAt, 'Chờ bắt đầu Tông Chiến');
        } else await this.fail(e, 'vào lãnh địa', alive);
        return false;
      }
    }

    chooseAction(match) {
      const skills = ((match.player && match.player.skills) || []).map(WarCatalog.skill);
      const hp = match.player_hp, hpMax = match.player && match.player.hp_max, mp = match.player_mp;
      const heal = SkillSelector.pickHeal(skills, hp, hpMax, mp, hpMax > 0 && hp > 0 && hp / hpMax < CFG.WAR_HEAL_BELOW_PCT);
      return heal || SkillSelector.pickAttack(skills, match.opponent && match.opponent.element, mp);
    }

    // Đánh tiếp một trận đã mở cho tới khi server báo finished. Trả kết quả (result) hoặc null nếu bỏ giữa chừng.
    async playMatch(match, alive) {
      const st = this.st;
      for (let n = 0; alive(); n++) {
        if (n >= CFG.WAR_MAX_ACTIONS) { this.log('Trận kéo dài quá nhiều đòn, thôi theo dõi trận này.'); return null; }
        const act = this.chooseAction(match);
        if (!act) { this.log('Không có chiêu dùng được trong trận (hết MP hoặc chưa trang bị chiêu công kích), chờ rồi thử lại.'); await sleepSlices(this.sleep, 2000, alive); continue; }
        await this.waitGap();
        if (!alive()) return null;
        this.markAttack();
        let d;
        try { d = await this.api.warAction({ action: 'skill', skillId: act.skill.id }); st.errors = 0; this.clearErrors(); }
        catch (e) {
          if (/không có trận|không tồn tại/i.test(e.message || '')) return null;
          await this.fail(e, 'đánh trong trận Tông Chiến', alive); continue;
        }
        if (d && d.match) match = d.match;
        if (d && d.finished) return d.result || {};
      }
      return null;
    }

    noteResult(r, who) {
      const st = this.st; if (!r || !r.result) return;
      if (r.attacksMade != null) st.attacks = Number(r.attacksMade) || st.attacks; else st.attacks++;
      st.nextAt = WarCatalog.ts(r.nextActionAt); st.woundedUntil = WarCatalog.ts(r.woundedUntil);
      const opp = r.opponent || who || {}, tag = `${opp.name || '?'}${opp.power ? ` (${opp.power})` : ''}`;
      if (r.result === 'win') {
        st.wins++; if (r.isGuard) st.guardWins++;
        st.points += Number(r.pointsGained) || 0; st.cp += Number(r.cpGained) || 0;
        this.log(`THẮNG ${tag} sau ${r.rounds} hiệp, còn ${r.myHpPct}% HP: +${r.cpGained} cp, +${r.pointsGained} điểm · lượt ${st.attacks}/${st.maxAttacks}.`);
      } else {
        st.losses++;
        this.log(`THUA ${tag} sau ${r.rounds} hiệp${st.woundedUntil ? `, dưỡng thương tới ${new Date(st.woundedUntil).toLocaleTimeString()}` : ''} · lượt ${st.attacks}/${st.maxAttacks}.`);
      }
      this.info();
    }

    // Một lượt: mở trận (người chơi hoặc thủ vệ) rồi đánh tới hết. 'wounded' = người đó vừa bị đánh, đã đánh dấu bỏ qua.
    async attackOnce(body, who, alive) {
      const st = this.st;
      await this.waitGap();
      if (!alive()) return null;
      this.markAttack();
      let m;
      try { m = await this.api.warAttack(body); st.errors = 0; this.clearErrors(); }
      catch (e) {
        if (/vừa bị thương/i.test(e.message || '') && body.targetCharacterId != null) { st.skips.set(body.targetCharacterId, this.now() + CFG.WAR_SKIP_MS); return 'wounded'; }
        await this.fail(e, 'mở trận Tông Chiến', alive);
        try { this.syncGarrison((await this.loadOverview()).me.garrison); } catch (_) {} // đọc lại lượt / dưỡng thương từ server
        return null;
      }
      const r = await this.playMatch(m, alive);
      this.noteResult(r, who);
      return r;
    }

    // Trận đang dở ở server (vd. vừa tải lại trang giữa trận): đánh nốt
    async resumeMatch(alive) {
      let m = null;
      try { m = await this.api.warMatch(); } catch (_) { return; }
      if (!m || !m.player || !m.opponent) return;
      this.log(`Tiếp tục trận đang dở với ${m.opponent.name || '?'}.`);
      this.noteResult(await this.playMatch(m, alive));
    }

    // Vòng đánh trong khung live. Trả về khi hết giờ, đủ lượt hoặc bị tắt.
    async fightDay(alive) {
      const st = this.st, day = st.day, key = day.key;
      await this.resumeMatch(alive);
      while (alive()) {
        const now = this.srvNow();
        if (now >= day.liveEndAt) { this.log('Hết giờ Tông Chiến hôm nay.'); return; }
        if (st.attacks >= st.maxAttacks) { st.doneDay = key; this.log(`Đã đủ ${st.maxAttacks} lượt hôm nay, nghỉ tới ngày mai.`); return; }
        const readyAt = Math.max(st.nextAt, st.woundedUntil);
        if (readyAt > now) { await this.waitUntil(alive, Math.min(readyAt, day.liveEndAt), st.woundedUntil > now ? 'Đang dưỡng thương' : 'Chờ lượt kế', 15000); continue; }
        let tg;
        try { tg = await this.api.warTargets(); st.errors = 0; }
        catch (e) { await this.fail(e, 'đọc mục tiêu Tông Chiến', alive); continue; }
        const t = this.now();
        for (const [id, until] of st.skips) if (until <= t) st.skips.delete(id);
        const players = WarCatalog.pickPlayers(tg && tg.targets, st.sectId, st.maxPower, id => st.skips.has(id));
        const guard = tg && tg.guard;
        let r;
        if (players.length) { const p = players[0]; this.status(`Đánh ${p.name} (${p.power})`); r = await this.attackOnce({ targetCharacterId: p.characterId }, p, alive); }
        else if (guard && guard.available && guard.remaining > 0) { this.status(`Đánh thủ vệ (còn ${guard.remaining} lần)`); r = await this.attackOnce({ guard: true }, { name: 'Thủ Vệ' }, alive); }
        else { this.status(guard && guard.remaining > 0 ? 'Chờ người chơi vào lãnh địa' : 'Hết lượt thủ vệ, chờ người chơi vào lãnh địa'); await sleepSlices(this.sleep, CFG.WAR_POLL_MS, alive); }
        if (r === 'wounded') continue;
      }
    }

    async execute(alive) {
      const st = this.st;
      st.scanAt = 0;
      while (alive()) {
        let ov;
        try { ov = await this.loadOverview(); st.errors = 0; this.clearErrors(); }
        catch (e) { await this.fail(e, 'đọc Tông Chiến', alive); continue; }
        this.info();
        if (!ov.enabled) { this.status('Server đang tắt Tông Chiến'); await sleepSlices(this.sleep, CFG.WAR_IDLE_POLL_MS, alive); continue; }
        if (!(ov.me && ov.me.sect)) { this.status('Bạn chưa vào tông nào'); await sleepSlices(this.sleep, CFG.WAR_IDLE_POLL_MS, alive); continue; }
        this.scan(ov); this.info();
        const day = ov.day || {}, now = this.srvNow();
        if (day.skipped || !day.liveStartAt || !day.liveEndAt || now >= day.liveEndAt) { await this.waitUntil(alive, now + CFG.WAR_IDLE_POLL_MS, day.skipped ? 'Hôm nay không có Tông Chiến' : 'Đã hết giờ Tông Chiến, chờ ngày mai'); continue; }
        if (st.doneDay === day.key) { await this.waitUntil(alive, day.liveEndAt + 1000, `Đã đủ ${st.maxAttacks} lượt hôm nay`); continue; }
        if (now < day.gatherAt) { await this.waitUntil(alive, day.gatherAt, 'Chờ tới giờ vào lãnh địa', Math.max(1000, Math.min(CFG.WAR_IDLE_POLL_MS, st.scanAt - this.now()))); continue; }
        if (!(await this.enter(ov, alive))) continue;
        if (this.srvNow() < day.liveStartAt) { await this.waitUntil(alive, day.liveStartAt, 'Chờ bắt đầu Tông Chiến', 30000); continue; }
        await this.fightDay(alive);
        if (alive() && st.doneDay !== day.key) await this.sleep(1000);
      }
    }
  }

  /* Nhớ chế độ nào đang được BẬT (theo ý người dùng) để tự chạy lại sau khi tải lại trang / đăng nhập lại */
  class ModeMemory {
    constructor(storage) {
      this.storage = storage;
      this.map = {};
      const m = storage.getJSON(ModeMemory.KEY, null);
      if (m && typeof m === 'object') for (const k of ModeMemory.ORDER) if (m[k] === true) this.map[k] = true;
      this.resumeOn = storage.getRaw(ModeMemory.RKEY) !== '0';
    }
    wants(key) { return this.map[key] === true; }
    set(key, on) {
      if (!ModeMemory.ORDER.includes(key)) return;
      if (on) this.map[key] = true; else delete this.map[key];
      this.storage.setJSON(ModeMemory.KEY, this.map);
    }
    setResume(on) { this.resumeOn = !!on; this.storage.setRaw(ModeMemory.RKEY, on ? '1' : '0'); }
    // engine tự dừng: chỉ giữ ý định nếu nghi do mất phiên đăng nhập; còn lại coi như chế độ đã kết thúc
    onSelfStop(key, authLost) { if (!authLost) this.set(key, false); }
    // các chế độ cần bật lại (theo thứ tự ưu tiên), bỏ qua cái đang chạy
    pending(isRunning) { return ModeMemory.ORDER.filter(k => this.wants(k) && !isRunning(k)); }
    list() { return ModeMemory.ORDER.filter(k => this.wants(k)); }
    static label(k) { return ModeMemory.LABELS[k] || k; }
  }
  ModeMemory.KEY = 'tt-auto-boss-run';
  ModeMemory.RKEY = 'tt-auto-boss-resume';
  ModeMemory.ORDER = ['bt', 'boss', 'um', 'hunt', 'tower', 'farm', 'xh', 'alchemy', 'garden', 'beast', 'war'];
  ModeMemory.LABELS = { bt: 'Đột phá', boss: 'Boss', um: 'U Minh Cốc', hunt: 'Săn yêu', tower: 'Leo tháp', farm: 'Tầm bảo', xh: 'Xuất hồn', alchemy: 'Luyện đan', garden: 'Linh điền', beast: 'Yêu thú', war: 'Tông Chiến' };

  /* ---------------------------------------------------------------------
   *  MỞ NHIỀU: dùng hàng loạt vật phẩm mở được (rương, effect_type "loot_box"), mỗi lượt tối đa CHEST_BATCH_MAX
   *  Phần thưởng tính bằng cách so túi đồ trước / sau (không phụ thuộc định dạng phản hồi). Lỗi (kể cả túi đầy) thì dừng.
   * --------------------------------------------------------------------- */
  class BulkUseCatalog {
    static isBox(it) { return !!it && it.effect_type === 'loot_box' && (Number(it.quantity) || 0) > 0; }
    static key(it) { return it.item_id != null ? it.item_id : it.name; }
    static boxes(inv) {
      const m = new Map();
      for (const it of Array.isArray(inv) ? inv : []) {
        if (!BulkUseCatalog.isBox(it)) continue;
        const k = BulkUseCatalog.key(it), cur = m.get(k);
        if (cur) cur.quantity += Number(it.quantity) || 0; else m.set(k, { ...it, quantity: Number(it.quantity) || 0 });
      }
      return [...m.values()].sort((a, b) => String(a.name).localeCompare(String(b.name), 'vi'));
    }
    static find(inv, key) { return BulkUseCatalog.boxes(inv).find(it => BulkUseCatalog.key(it) === key) || null; }
    static label(it) { return `${it.name} ×${it.quantity.toLocaleString('en-US')}`; }
    // vật phẩm tăng thêm (theo tên) giữa 2 lần chụp túi đồ, nhiều nhất trước; bỏ qua loại có key = skipKey
    static gains(before, after, skipKey) {
      const sum = inv => { const m = new Map(); for (const it of Array.isArray(inv) ? inv : []) { if (BulkUseCatalog.key(it) === skipKey) continue; const o = m.get(it.name) || 0; m.set(it.name, o + (Number(it.quantity) || 0)); } return m; };
      const a = sum(before), b = sum(after), out = [];
      for (const [name, q] of b) { const d = q - (a.get(name) || 0); if (d > 0) out.push({ name, delta: d }); }
      return out.sort((x, y) => y.delta - x.delta);
    }
  }

  class BulkUseEngine extends EventEmitter {
    constructor(deps) { super(); this.api = deps.api; this.sleep = deps.sleep; this.stopped = false; this.running = false; }
    log(m) { this.emit('log', m); }
    stop() { this.stopped = true; }
    async run(key) {
      if (this.running) return null;
      this.running = true; this.stopped = false;
      const { api } = this; const fmt = n => n.toLocaleString('en-US');
      let opened = 0, total = 0, name = '?', err = null, before = null, meB = null;
      try {
        before = await api.getInventory();
        meB = api.getMe ? await api.getMe().catch(() => null) : null;
        let row = BulkUseCatalog.find(before, key);
        if (!row) { this.log('Mở nhiều: vật phẩm đã chọn không còn trong túi.'); return null; }
        name = row.name; total = row.quantity;
        this.log(`Mở nhiều ${name}: có ${fmt(total)}, mỗi lượt tối đa ${CFG.CHEST_BATCH_MAX}.`);
        let remaining = total, batch = 0;
        while (remaining > 0 && !this.stopped) {
          const n = Math.min(remaining, CFG.CHEST_BATCH_MAX);
          batch++;
          this.emit('status', `Đang mở ${fmt(opened)}/${fmt(total)} (lượt ${batch}: ${n} cái)...`);
          try { await api.useItem(row.id, n); } catch (e) { err = e; break; }
          opened += n; remaining -= n;
          let inv = null; try { inv = await api.getInventory(); } catch (_) {}
          if (inv) {
            this.emit('inventory', inv);
            const r2 = BulkUseCatalog.find(inv, key);
            if (r2) { row = { ...row, id: r2.id }; remaining = Math.min(remaining, r2.quantity); } else remaining = 0;
          }
          if (remaining > 0 && !this.stopped) await sleepSlices(this.sleep, CFG.CHEST_CALL_GAP_MS, () => !this.stopped);
        }
      } catch (e) { err = e; }
      let gains = [], stones = 0, locked = 0;
      try {
        if (before) {
          const after = await api.getInventory(); this.emit('inventory', after);
          gains = BulkUseCatalog.gains(before, after, key);
          const meA = api.getMe && meB ? await api.getMe().catch(() => null) : null;
          if (meA && meB) { stones = (meA.spirit_stones || 0) - (meB.spirit_stones || 0); locked = (meA.locked_spirit_stones || 0) - (meB.locked_spirit_stones || 0); }
        }
      } catch (_) {}
      const bagFull = !!err && /đầy/i.test(err.message || '');
      let head = `Đã mở ${fmt(opened)}/${fmt(total)} ${name}${this.stopped ? ' (đã dừng)' : ''}`;
      if (err) head += `. Dừng vì lỗi: ${err.message}${bagFull ? ' (túi đồ đầy)' : ''}`;
      this.log(head + '.');
      const parts = gains.map(g => `${g.name} ×${fmt(g.delta)}`);
      if (stones > 0) parts.push(`linh thạch +${fmt(stones)}`);
      if (locked > 0) parts.push(`linh thạch khóa +${fmt(locked)}`);
      if (parts.length) this.log(`Nhận: ${parts.join(', ')}`);
      else if (opened) this.log('Không thấy vật phẩm mới trong túi đồ.');
      this.emit('status', head);
      if (bagFull) this.emit('bagfull');
      this.running = false;
      return { opened, total, gains, stones, locked, error: err ? err.message : null, bagFull, stopped: this.stopped };
    }
  }

  /* ---------------------------------------------------------------------
   *  BÁN ĐỒ: bán một loại vật phẩm trong túi theo số lượng đã chọn (POST /api/items/sell {inventoryId, quantity}, mỗi lệnh tối đa 999)
   *  Chỉ liệt kê đồ bán được: không đang trang bị, không cường hóa, không khóa bán, có giá bán. Lỗi thì dừng ngay.
   * --------------------------------------------------------------------- */
  class SellCatalog {
    static key(it) { return it.item_id != null ? it.item_id : it.name; }
    static sellable(it) {
      return !!it && (Number(it.quantity) || 0) > 0 && (Number(it.price_sell) || 0) > 0 && !it.is_equipped
        && !(Number(it.enhancement_level) > 0) && !it.is_locked_sell;
    }
    // gộp theo loại; rows giữ từng dòng túi để bán lần lượt
    static items(inv) {
      const m = new Map();
      for (const it of Array.isArray(inv) ? inv : []) {
        if (!SellCatalog.sellable(it)) continue;
        const k = SellCatalog.key(it), q = Number(it.quantity), cur = m.get(k);
        if (cur) { cur.quantity += q; cur.rows.push({ id: it.id, quantity: q }); }
        else m.set(k, { key: k, name: it.name, rarity: it.rarity, price: Number(it.price_sell), quantity: q, rows: [{ id: it.id, quantity: q }] });
      }
      return [...m.values()].sort((a, b) => String(a.name).localeCompare(String(b.name), 'vi'));
    }
    static find(inv, key) { return SellCatalog.items(inv).find(x => x.key === key) || null; }
    static label(x) { return `${x.name} ×${x.quantity.toLocaleString('en-US')} (${x.price.toLocaleString('en-US')}/cái)`; }
    static clamp(x, qty) { const n = Math.floor(Number(qty)); return Math.max(1, Math.min(x ? x.quantity : 1, Number.isFinite(n) ? n : 1)); }
    static estimate(x, qty) { return x ? x.price * SellCatalog.clamp(x, qty) : 0; }
    static isHigh(x) { return !!x && ['epic', 'legendary', 'mythic'].includes(String(x.rarity)); }
    // chia số lượng cần bán thành các lệnh: [{id, quantity}], mỗi lệnh ≤ maxPer và nằm trong một dòng túi
    static plan(x, qty, maxPer) {
      const out = []; let left = SellCatalog.clamp(x, qty);
      for (const r of x.rows) {
        let q = Math.min(r.quantity, left);
        while (q > 0) { const n = Math.min(q, maxPer); out.push({ id: r.id, quantity: n }); q -= n; left -= n; }
        if (left <= 0) break;
      }
      return out;
    }
  }

  class SellEngine extends EventEmitter {
    constructor(deps) { super(); this.api = deps.api; this.sleep = deps.sleep; this.stopped = false; this.running = false; }
    log(m) { this.emit('log', m); }
    stop() { this.stopped = true; }
    async run(key, qty) {
      if (this.running) return null;
      this.running = true; this.stopped = false;
      const { api } = this; const fmt = n => Number(n).toLocaleString('en-US');
      let sold = 0, want = 0, name = '?', err = null, before = null, meB = null, goldResp = 0;
      try {
        before = await api.getInventory();
        meB = api.getMe ? await api.getMe().catch(() => null) : null;
        const x = SellCatalog.find(before, key);
        if (!x) { this.log('Bán đồ: vật phẩm đã chọn không còn bán được.'); return null; }
        name = x.name; want = SellCatalog.clamp(x, qty);
        const plan = SellCatalog.plan(x, want, CFG.SELL_MAX_PER_CALL);
        this.log(`Bán ${fmt(want)} ${name} (${plan.length} lệnh, tối đa ${CFG.SELL_MAX_PER_CALL} cái/lệnh).`);
        for (let i = 0; i < plan.length && !this.stopped; i++) {
          const p = plan[i];
          this.emit('status', `Đang bán ${fmt(sold)}/${fmt(want)} (lệnh ${i + 1}/${plan.length})...`);
          try { const d = await api.sellItem(p.id, p.quantity); goldResp += Number(d && d.goldGained) || 0; } catch (e) { err = e; break; }
          sold += p.quantity;
          if (i < plan.length - 1 && !this.stopped) await sleepSlices(this.sleep, CFG.SELL_CALL_GAP_MS, () => !this.stopped);
        }
      } catch (e) { err = e; }
      let stones = 0, locked = 0;
      try {
        const after = await api.getInventory(); this.emit('inventory', after);
        const meA = api.getMe && meB ? await api.getMe().catch(() => null) : null;
        if (meA && meB) { stones = (meA.spirit_stones || 0) - (meB.spirit_stones || 0); locked = (meA.locked_spirit_stones || 0) - (meB.locked_spirit_stones || 0); }
      } catch (_) {}
      let head = `Đã bán ${fmt(sold)}/${fmt(want)} ${name}${this.stopped ? ' (đã dừng)' : ''}`;
      if (err) head += `. Dừng vì lỗi: ${err.message}`;
      this.log(head + '.');
      const parts = [];
      if (stones > 0) parts.push(`linh thạch +${fmt(stones)}`);
      if (locked > 0) parts.push(`linh thạch khóa +${fmt(locked)}`);
      if (!parts.length && goldResp > 0) parts.push(`+${fmt(goldResp)} linh thạch`);
      if (parts.length) this.log(`Nhận: ${parts.join(', ')}`);
      this.emit('status', head);
      this.running = false;
      return { sold, want, stones, locked, error: err ? err.message : null, stopped: this.stopped };
    }
  }

  // Hàng chờ lệnh gọi game: hai lệnh liên tiếp BẮT ĐẦU GỬI cách nhau tối thiểu `gapMs` (lệnh đang chạy không bị chặn lại giữa chừng), nên lệnh đến khi
  // hàng trống chỉ chờ tối đa `gapMs`. 3 mức ưu tiên (0 cao nhất); cùng mức thì vào trước đi trước; chờ quá agingMs thì được nâng một mức mỗi lần.
  // Lệnh đọc (GET) cùng địa chỉ đang chờ trong hàng thì gộp làm một. pause(ms) dừng cả hàng (khi server báo gọi quá nhiều).
  // windowMs chỉ để đếm số lệnh đã gửi trong khoảng gần nhất (hiển thị), không giới hạn.
  class RequestQueue {
    constructor({ gapMs = CFG.REQ_GAP_MS, windowMs = CFG.REQ_WINDOW_MS, agingMs = CFG.REQ_AGING_MS, now = () => Date.now(), sleep = ms => new Promise(r => setTimeout(r, ms)), onLog = null } = {}) {
      Object.assign(this, { gapMs, windowMs, agingMs, now, sleep, onLog });
      this.times = []; this.items = []; this.pausedUntil = 0; this.pumping = false; this.lastWarn = -Infinity; this.pending = new Map(); this.sent = 0; this.lastStart = -Infinity;
    }
    prune() { const t = this.now() - this.windowMs; while (this.times.length && this.times[0] <= t) this.times.shift(); }
    stats() { this.prune(); return { used: this.times.length, gapMs: this.gapMs, waiting: this.items.length }; }
    pause(ms) { this.pausedUntil = Math.max(this.pausedUntil, this.now() + ms); }
    // fn: () => Promise (gửi thật). opts: { prio: 0|1|2, key: chuỗi để gộp lệnh GET trùng, label }
    run(fn, opts = {}) {
      const key = opts.key || null;
      if (key && this.pending.has(key)) { const it = this.pending.get(key); it.prio = Math.min(it.prio, opts.prio ?? 2); return it.promise; }
      const it = { fn, prio: opts.prio ?? 2, key, at: this.now(), label: opts.label || '' };
      it.promise = new Promise((res, rej) => { it.res = res; it.rej = rej; });
      this.items.push(it); if (key) this.pending.set(key, it);
      this.pump();
      return it.promise;
    }
    eff(it) { return Math.max(0, it.prio - Math.floor((this.now() - it.at) / this.agingMs)); }
    next() {
      let best = null, bp = 9;
      for (const it of this.items) { const p = this.eff(it); if (p < bp) { best = it; bp = p; } } // cùng mức: giữ lệnh vào trước (items theo thứ tự vào)
      return best;
    }
    async pump() {
      if (this.pumping) return; this.pumping = true;
      try {
        while (this.items.length) {
          const wake = Math.max(this.pausedUntil, this.lastStart + this.gapMs);
          const wait = wake - this.now();
          if (wait > 0) { await this.sleep(Math.min(wait, 1000) + 1); continue; }
          const it = this.next(); this.items.splice(this.items.indexOf(it), 1); if (it.key) this.pending.delete(it.key);
          const waited = this.now() - it.at;
          if (waited > CFG.REQ_WARN_WAIT_MS && this.now() - this.lastWarn >= CFG.REQ_WARN_EVERY_MS && this.onLog) { this.lastWarn = this.now(); this.onLog(`Hàng chờ lệnh: lệnh ${it.label || ''} phải chờ ${(waited / 1000).toFixed(1)}s (hàng đang dồn, còn ${this.items.length} lệnh chờ; mỗi lệnh cách nhau ${(this.gapMs / 1000).toFixed(2)}s).`); }
          this.lastStart = this.now(); this.prune(); this.times.push(this.lastStart); this.sent++;
          Promise.resolve().then(it.fn).then(it.res, it.rej);
        }
      } finally { this.pumping = false; }
    }
  }

  /* ===================== EXPORT CHO TEST ===================== */
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      // class
      BossCatalog, BeastCatalog, BeastEngine, BulkUseCatalog, BulkUseEngine, SellCatalog, SellEngine, BreakthroughCatalog, ModeMemory, AutoLogin, TowerEngine, SkillSwapper, SkillCatalog, HealSkillConfig, HpPillService, PillBook, HpPillConfig, RequestQueue, MpPillConfig, HpGate, EventEmitter, StateMachine, RateLimiter, Coordinator, inBossWindow, PillConfig, MpGate, Healer, PillManager,
      Engine, BossEngine, MatchEngine, FarmEngine, HuntEngine, BreakthroughEngine, AlchemyEngine, UMinhEngine, GardenEngine, GardenCatalog, XuatHonEngine, XuatHonCatalog, WarEngine, WarCatalog,
      ElementRules, SkillSelector, CombatFormatter, MonsterCatalog, PillCatalog, AlchemyCatalog, UMinhPlanner,
      // tương thích tên cũ (v1.2.8)
      createEngine: d => new BossEngine(d), createFarmEngine: d => new FarmEngine(d), createHuntEngine: d => new HuntEngine(d),
      createBreakthrough: d => new BreakthroughEngine(d), createPills: d => new PillManager(d),
      fmtPct: CombatFormatter.fmtPct, sumHits: CombatFormatter.sumHits, fightLine: CombatFormatter.fightLine,
      relation: ElementRules.relation, pickAttack: SkillSelector.pickAttack, pickBoss: BossCatalog.pick,
      sortMonsters: MonsterCatalog.sort, pickDefaultMonster: MonsterCatalog.pickDefault, canFight: MonsterCatalog.canFight, monsterLabel: MonsterCatalog.label,
      mpPillValue: PillCatalog.mpValue, pickMpPill: PillCatalog.pick, newMpGate, newPillCfg,
      ZONES, DEFAULT_ZONE, CFG, VERSION,
    };
    return;
  }

  /* =====================================================================
   *  5. HẠ TẦNG MẠNG: bắt token và gọi API của game
   * ===================================================================== */
  class GameApi {
    constructor() {
      this.auth = null; this.lastUnauthorized = 0;
      this.origFetch = window.fetch.bind(window);
      this.queue = new RequestQueue({ onLog: m => { if (this.onLog) this.onLog(m); } });
      this.onLog = null;
    }
    // mức ưu tiên theo địa chỉ: 0 = boss / đột phá / đổi chiêu; 1 = đòn trong trận của các chế độ (và đọc HP, bộ chiêu); 2 = việc còn lại
    static priorityOf(method, url) {
      if (/^\/api\/(boss\/|character\/breakthrough|character\/skills\/(equip|unequip)|character\/techniques\/activate)/.test(url)) return 0;
      if (/^\/api\/(dungeon\/farm\/|combat\/hunt\/|tower\/|u-minh\/|sect-war\/|character\/me|pvp\/skills\/equipped)/.test(url)) return 1;
      return 2;
    }

    // Bắt header Authorization từ chính các request của game (tài khoản của bạn, phiên của bạn)
    install() {
      const self = this;
      const origSetHeader = XMLHttpRequest.prototype.setRequestHeader;
      XMLHttpRequest.prototype.setRequestHeader = function (k, v) {
        if (/^authorization$/i.test(k) && v) self.auth = v;
        return origSetHeader.apply(this, arguments);
      };
      window.fetch = function (input, init) {
        try {
          const h = (init && init.headers) || (input && input.headers);
          if (h) {
            const v = typeof h.get === 'function' ? h.get('authorization') : (h.authorization || h.Authorization);
            if (v) self.auth = v;
          }
        } catch (_) {}
        return self.origFetch(input, init);
      };
      return this;
    }

    // Dự phòng: tìm JWT trong localStorage/sessionStorage
    static tokenFromStorage() {
      const re = /eyJ[\w-]+\.[\w-]+\.[\w-]+/;
      for (const store of [window.localStorage, window.sessionStorage]) {
        try {
          for (let i = 0; i < store.length; i++) {
            const m = String(store.getItem(store.key(i))).match(re);
            if (m) return 'Bearer ' + m[0];
          }
        } catch (_) {}
      }
      return null;
    }

    // Mọi lệnh gọi game đi qua hàng chờ (giãn cách ~1 lệnh/giây). prio bỏ trống = theo địa chỉ (priorityOf).
    // Server báo gọi quá nhiều (HTTP 429 / "too many requests"): dừng cả hàng 10s (hoặc theo Retry-After), gửi lại đúng lệnh đó một lần.
    async http(method, url, body, prio) {
      const p = prio ?? GameApi.priorityOf(method, url);
      const key = method === 'GET' ? `GET ${url}` : null; // chỉ lệnh đọc mới được gộp
      try { return await this.queue.run(() => this.rawHttp(method, url, body), { prio: p, key, label: `${method} ${url}` }); }
      catch (e) {
        if (!e.rateLimited || e.retried) throw e;
        const ms = Math.max(CFG.REQ_PAUSE_MS, (e.retryAfter || 0) * 1000);
        this.queue.pause(ms);
        if (this.onLog) this.onLog(`Server báo gọi quá nhiều (${e.message}): tạm dừng hàng chờ ${Math.round(ms / 1000)}s rồi gửi lại lệnh ${method} ${url} một lần.`);
        try { return await this.queue.run(() => this.rawHttp(method, url, body), { prio: Math.min(p, 1), key, label: `${method} ${url}` }); }
        catch (e2) { e2.retried = true; throw e2; }
      }
    }

    async rawHttp(method, url, body) {
      const headers = {};
      if (body) headers['content-type'] = 'application/json';
      const auth = this.auth || GameApi.tokenFromStorage();
      if (auth) headers.authorization = auth;
      let r;
      try {
        r = await this.origFetch(url, {
          method, credentials: 'include', headers,
          body: body ? JSON.stringify(body) : undefined,
          signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(CFG.HTTP_TIMEOUT_MS) : undefined,
        });
      } catch (e) {
        if (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) throw new Error(`Hết thời gian chờ server (${CFG.HTTP_TIMEOUT_MS / 1000}s)`);
        throw e;
      }
      let j = null; try { j = await r.json(); } catch (_) {}
      if (r.status === 401) this.lastUnauthorized = Date.now(); // để biết mất phiên đăng nhập (ModeMemory giữ ý định chạy lại)
      if (!r.ok || !j || j.success === false) {
        let msg = (j && (j.message || j.error)) || `HTTP ${r.status}`;
        if (r.status === 401 && !auth) msg += ' (chưa bắt được token: hãy bấm vào 1 tab bất kỳ trong game, hoặc tải lại trang, rồi bấm Bật lại)';
        const err = new Error(msg); err.status = r.status;
        err.rateLimited = r.status === 429 || /too many requests|rate.?limit|quá nhiều (yêu cầu|request|lệnh)/i.test(msg); // "quá nhanh" riêng của U Minh Cốc là thời gian hồi bước đi, không dừng cả hàng
        try { err.retryAfter = Number(r.headers && r.headers.get && r.headers.get('retry-after')) || 0; } catch (_) {}
        throw err;
      }
      return j;
    }

    // boss
    async getActive() { return (await this.http('GET', '/api/boss/active')).data; }
    async getBoss(id) { return (await this.http('GET', `/api/boss/${id}`)).data; }
    async getSkills() { return (await this.http('GET', '/api/pvp/skills/equipped')).data; }
    attack(id, body) { return this.http('POST', `/api/boss/${id}/attack`, body); }
    async getMe() { return (await this.http('GET', '/api/character/me')).data; }
    // tầm bảo
    async getZones() { return (await this.http('GET', '/api/dungeon/farm/zones')).data; }
    async farmState() { return (await this.http('GET', '/api/dungeon/farm/state')).data; }
    async explore(zoneCode) { return (await this.http('POST', '/api/dungeon/farm/explore', { zoneCode })).data; }
    farmAction(body) { return this.http('POST', '/api/dungeon/farm/action', body); }
    // trang bị / tháo vật phẩm (chiêu thức): phản hồi kèm { character, inventory }
    // Chiêu thức nằm trong danh sách "đã học" riêng, không còn trong túi đồ. Kết quả đã chuẩn hóa: { slots, skills } (skills[].id = item_id)
    async getSkillBook() { return SkillCatalog.normalize((await this.http('GET', '/api/character/skills/known')).data); }
    // body { skillId } (trước là { itemId })
    async equipSkill(skillId) { return SkillCatalog.normalize((await this.http('POST', '/api/character/skills/equip', { skillId })).data); }
    async unequipSkill(skillId) { return SkillCatalog.normalize((await this.http('POST', '/api/character/skills/unequip', { skillId })).data); }
    // đan hồi MP
    async getInventory(prio) { return (await this.http('GET', '/api/items/inventory', undefined, prio)).data; }
    async useItem(inventoryId, quantity, prio) { return (await this.http('POST', '/api/items/use', { inventoryId, quantity }, prio)).data; }
    // đột phá
    async breakthroughPreview() { return (await this.http('GET', '/api/character/breakthrough/preview')).data; }
    async breakthrough() { return (await this.http('POST', '/api/character/breakthrough')).data; }
    // luyện đan
    async getAlchemyState() { return (await this.http('GET', '/api/alchemy/state')).data; }
    // yêu thú: danh sách, xem trước phóng sinh, phóng sinh
    async getBeasts() { return (await this.http('GET', '/api/beasts')).data; }
    async beastReleasePreview(id) { return (await this.http('GET', `/api/beasts/${id}/release-preview`)).data; }
    async releaseBeast(id) { return (await this.http('DELETE', `/api/beasts/${id}`)).data; }
    // xuất hồn (đi bí cảnh theo giờ, chạy ngầm phía server)
    async xhOptions() { return (await this.http('GET', '/api/xuat-hon/options')).data; }
    async xhStatus() { return (await this.http('GET', '/api/xuat-hon/status')).data; }
    async xhStart(dungeonCode, durationMinutes) { return (await this.http('POST', '/api/xuat-hon/start', { dungeonCode, durationMinutes })).data; }
    async xhClaim() { return (await this.http('POST', '/api/xuat-hon/claim')).data; }
    async xhAbandon() { return (await this.http('POST', '/api/xuat-hon/abandon')).data; }
    async alchemyCraft(recipeId, times) { return (await this.http('POST', '/api/alchemy/craft', { recipeId, times })).data; }
    // Linh điền
    async getGardenState() { return (await this.http('GET', '/api/linh-dien/state')).data; }
    async gardenHarvest(slotIndex) { return (await this.http('POST', '/api/linh-dien/harvest', { slotIndex })).data; }
    async gardenPlant(slotIndex, seedId) { return (await this.http('POST', '/api/linh-dien/plant', { slotIndex, seedId })).data; }
    // U Minh Cốc (spawn: top | bottom | left | right; dir: up | down | left | right)
    async uminhState(since) { return (await this.http('GET', '/api/u-minh/state' + (since != null ? `?since=${since}` : ''))).data; }
    async uminhJoin(spawn) { return (await this.http('POST', '/api/u-minh/join', { spawn })).data; }
    async getKnownTechniques() { return (await this.http('GET', '/api/character/techniques/known')).data; }
    async activateTechnique(techniqueId) { return (await this.http('POST', '/api/character/techniques/activate', { techniqueId })).data; }
    async sellItem(inventoryId, quantity) { return (await this.http('POST', '/api/items/sell', { inventoryId, quantity })).data; }
    // Tông Chiến (attack mở trận, match/action đánh từng đòn tới khi finished)
    async warOverview() { return (await this.http('GET', '/api/sect-war/overview')).data; }
    async warTargets() { return (await this.http('GET', '/api/sect-war/targets')).data; }
    async warMatch() { return (await this.http('GET', '/api/sect-war/match')).data; }
    async warGarrison(territoryCode) { return (await this.http('POST', '/api/sect-war/garrison', { territoryCode })).data; }
    async warAttack(body) { return (await this.http('POST', '/api/sect-war/attack', body)).data; }
    async warAction(body) { return (await this.http('POST', '/api/sect-war/match/action', body)).data; }
    async uminhLeave() { return (await this.http('POST', '/api/u-minh/leave')).data; }
    async uminhMove(dir) { return (await this.http('POST', '/api/u-minh/move', { dir })).data; }
    uminhAction(body) { return this.http('POST', '/api/u-minh/action', body); }
    // leo tháp
    async towerState() { return (await this.http('GET', '/api/tower/state')).data; }
    async towerStart() { return (await this.http('POST', '/api/tower/start')).data; }
    towerAction(body) { return this.http('POST', '/api/tower/action', body); }
    // săn yêu
    async getMonsters() { return (await this.http('GET', '/api/combat/monsters')).data; }
    async getTickets() { return (await this.http('GET', '/api/combat/hunt/tickets')).data; }
    async huntState() { return (await this.http('GET', '/api/combat/hunt/match')).data; }
    async huntStart(monsterId) { return (await this.http('POST', '/api/combat/hunt/start', { monsterId })).data; }
    huntAction(body) { return this.http('POST', '/api/combat/hunt/action', body); }
  }

  /* =====================================================================
   *  6. UI (View) - chỉ biết DOM, giao tiếp bằng sự kiện
   *
   *  Sự kiện PanelView phát ra (ý định của người dùng):
   *    'boss:toggle' | 'boss:size'(size, checked) | 'boss:mode'(size, mode)
   *    'farm:toggle' | 'farm:zone'(code)
   *    'hunt:toggle' | 'hunt:monster'(id) | 'hunt:refresh'
   *    'bt:toggle'(checked) | 'mp:toggle'(k, checked) | 'mp:range'(k, lo, hi) | 'mgate:toggle'(k, checked) | 'mgate:range'(k, lo, hi) | 'hgate:toggle'(k, checked) | 'hgate:range'(k, lo, hi) | 'pill:refill' | 'alchemy:toggle' | 'alchemy:recipe'(id) | 'alchemy:refresh' | 'bulk:main'(checked) | 'bulk:add' | 'bulk:set'(oldId, newId) | 'bulk:toggle'(id, checked) | 'bulk:remove'(id) | 'um:toggle' | 'um:gate'(key) | 'tower:toggle' | 'swap:toggle'(checked) | 'login:config'({enabled,user,pass}) | 'resume:toggle'(checked) | 'beast:toggle' | 'beast:filter'({rar,keep}) | 'beast:hatch' | 'beast:release' | 'swap:pool'(ids) | 'skill:lock'(id) | 'garden:toggle' | 'garden:seed'(id) | 'garden:refresh' | 'garden:harvest'(on) | 'garden:plant'(on) | 'skill:equip'(inventoryId) | 'skill:unequip'(inventoryId) | 'skill:refresh' | 'hp:toggle'(mode, checked) | 'hp:range'(mode, lo, hi) | 'pillbook:select'(kind, id, name) | 'pillbook:refresh' | 'pill:range'(lo, hi) | 'gate:range'(lo, hi)
   * ===================================================================== */

  const COLORS = { // Bảng màu log (func4-8: func4 dùng cho đột phá, còn lại định nghĩa sẵn)
    tool: '#8fb8c9', result: '#72d8b0', error: '#ff7a66',
    boss: '#b9a8f7', hunt: '#6fd3e8', farm: '#e3c45b', tower: '#a6d96a', swap: '#f0b24c',
    xh: '#e8b4a0', war: '#f0a35e', func4: '#f08cc0', func5: '#f5a25d', func6: '#4fd1be', func7: '#9aa5f5', func8: '#e49bef',
  };
  const ERR_RE = /^(Lỗi|⚠)|lỗi|thất bại|tự dừng|không tải được/i;
  const OK_RE = /thắng|thành công|hạ gục|đã bị đánh bại|dưỡng thương xong|đã hồi|nhận được|hoàn thành/i;

  // localStorage an toàn (không bao giờ ném lỗi)
  class SafeStorage {
    getRaw(key) { try { return localStorage.getItem(key); } catch (_) { return null; } }
    setRaw(key, v) { try { localStorage.setItem(key, v); } catch (_) {} }
    getJSON(key, fallback) { try { const v = JSON.parse(localStorage.getItem(key) || 'null'); return v == null ? fallback : v; } catch (_) { return fallback; } }
    setJSON(key, v) { this.setRaw(key, JSON.stringify(v)); }
    remove(key) { try { localStorage.removeItem(key); } catch (_) {} }
  }

  // Thanh trượt 2 nút, 9 nấc 10..90%, hai nút không được trùng (dùng cho đan hồi MP và ngưỡng tạm dừng)
  class DualSlider extends EventEmitter {
    // mặc định thang 10 – 90, nấc 10; đan hồi HP dùng thang 5 – 95, nấc 5 (min / max / step / tickValues), key = null thì không tự lưu
    constructor({ loEl, hiEl, defLo, defHi, storage, key, min = 10, max = 90, step = 10, tickValues = null, labelStep = 1 }) {
      super();
      Object.assign(this, { loEl, hiEl, defLo, defHi, storage, key, min, max, step, tickValues, labelStep });
      this.wrap = loEl.parentElement;
      this.fill = this.wrap.querySelector('.ab-fill');
      this.ticks = this.wrap.nextElementSibling;
    }
    static tickX(v, min = 10, max = 90) { return `calc(var(--abh, 7px) + (100% - 2 * var(--abh, 7px)) * ${(v - min) / (max - min)})`; }
    valid(lo, hi) { const { min, max, step } = this; return lo >= min && hi <= max && lo < hi && (lo - min) % step === 0 && (hi - min) % step === 0; }
    init() {
      const { min, max, step } = this;
      const vals = this.tickValues || Array.from({ length: Math.floor((max - min) / step) + 1 }, (_, i) => min + i * step);
      for (const v of vals) { const t = document.createElement('span'); t.textContent = ((v - min) / step) % this.labelStep === 0 ? v : ''; t.style.left = DualSlider.tickX(v, min, max); this.ticks.appendChild(t); }
      if (!this.preset) { this.loEl.value = this.defLo; this.hiEl.value = this.defHi; } // đã được đặt từ bên ngoài (set) trước init thì giữ nguyên
      const sv = this.key && !this.preset ? this.storage.getJSON(this.key, null) : null;
      if (sv && this.valid(sv.lo, sv.hi)) { this.loEl.value = sv.lo; this.hiEl.value = sv.hi; }
      this.loEl.addEventListener('input', () => this.sync('low'));
      this.hiEl.addEventListener('input', () => this.sync('high'));
      this.sync();
      return this;
    }
    // đặt giá trị từ bên ngoài (đã kiểm tra hợp lệ), không phát sự kiện
    set(lo, hi) { if (this.valid(lo, hi)) { this.loEl.value = lo; this.hiEl.value = hi; this.preset = true; this.draw(lo, hi); } }
    draw(lo, hi) { const { min, max } = this; this.fill.style.left = `${(lo - min) / (max - min) * 100}%`; this.fill.style.width = `${(hi - lo) / (max - min) * 100}%`; } // .ab-track đã trừ 7px hai bên
    sync(changed) {
      const { min, max, step } = this;
      let lo = Number(this.loEl.value), hi = Number(this.hiEl.value);
      if (lo >= hi) { // không cho trùng: nút đang kéo dừng lại cách nút kia 1 nấc
        if (changed === 'low') lo = hi - step; else hi = lo + step;
        if (lo < min) { lo = min; hi = min + step; }
        if (hi > max) { hi = max; lo = max - step; }
      }
      this.loEl.value = lo; this.hiEl.value = hi;
      this.draw(lo, hi);
      if (this.key) this.storage.setJSON(this.key, { lo, hi });
      this.emit('change', lo, hi);
    }
  }

  // Thanh trượt 1 nút 5 – 95%, nấc 5%, hiện số xen kẽ (5, 15, 25 … 95); dùng cho mức "Hồi HP ngay". Giá trị lưu trong localStorage (key)
  class SingleSlider extends EventEmitter {
    constructor({ el, defVal, storage, key, min = 5, max = 95, step = 5, labelStep = 2 }) {
      super();
      Object.assign(this, { el, defVal, storage, key, min, max, step, labelStep });
      this.wrap = el.parentElement; this.fill = this.wrap.querySelector('.ab-fill'); this.ticks = this.wrap.nextElementSibling;
    }
    valid(v) { const { min, max, step } = this; return Number.isInteger(v) && v >= min && v <= max && (v - min) % step === 0; }
    init() {
      const { min, max, step } = this;
      for (let v = min, i = 0; v <= max; v += step, i++) { const t = document.createElement('span'); t.textContent = i % this.labelStep === 0 ? v : ''; t.style.left = DualSlider.tickX(v, min, max); this.ticks.appendChild(t); }
      this.el.value = this.defVal;
      const sv = this.key ? this.storage.getJSON(this.key, null) : null;
      if (this.valid(sv)) this.el.value = sv;
      this.el.addEventListener('input', () => this.sync());
      this.sync();
      return this;
    }
    get value() { return Number(this.el.value); }
    sync() {
      const v = this.value, { min, max } = this;
      this.fill.style.left = '0'; this.fill.style.width = `${(v - min) / (max - min) * 100}%`;
      if (this.key) this.storage.setJSON(this.key, v);
      this.emit('change', v);
    }
  }

  class PanelView extends EventEmitter {
    constructor(storage) {
      super();
      this.storage = storage;
      this.panel = this.build();
      const q = s => this.panel.querySelector(s);
      this.$log = q('#ab-log');
      this.$boss = q('#ab-toggle'); this.$farm = q('#ab-farm-toggle'); this.$hunt = q('#ab-hunt-toggle');
      this.$zone = q('#ab-zone'); this.$monster = q('#ab-monster'); this.$tickets = q('#ab-tickets'); this.$farmTickets = q('#ab-farm-tickets');
      this.$btOn = q('#ab-bt-on'); this.$btPillOn = q('#ab-bt-pill-on'); this.$btPill = q('#ab-bt-pill'); this.$pillNow = q('#ab-pill-now');
      this.$alchemy = q('#ab-alchemy-toggle'); this.$recipe = q('#ab-alchemy-recipe'); this.$bulkMain = q('#ab-bulk-main'); this.$bulkList = q('#ab-bulk-list'); this.$bulkAdd = q('#ab-bulk-add'); this.recipes = []; this.bulk = null;
      this.$garden = q('#ab-garden-toggle'); this.$seed = q('#ab-garden-seed'); this.$gardenStones = q('#ab-garden-stones'); this.gOpts = { harvest: true, plant: true }; this.gRunning = false; this.$gHarvest = q('#ab-garden-harvest'); this.$gPlant = q('#ab-garden-plant'); this.$gardenStatus = q('#ab-garden-status');
      this.$skills = q('#ab-skills'); this.$skillPending = q('#ab-skill-pending'); this.$swap = q('#ab-autoswap'); this.$swapPool = q('#ab-swap-pool'); this.$swapPoolList = q('#ab-swap-pool-list');
      this.$pbHp = q('#ab-pillbook-hp'); this.$pbMp = q('#ab-pillbook-mp');
      this.$sellSel = q('#ab-sell-item'); this.$sellQty = q('#ab-sell-qty'); this.$sellPreview = q('#ab-sell-preview'); this.$sellGo = q('#ab-sell-go'); this.$sellStatus = q('#ab-sell-status');
      this.$chestSel = q('#ab-chest-item'); this.$chestOpen = q('#ab-chest-open'); this.$chestStatus = q('#ab-chest-status');
      this.$beast = q('#ab-beast-toggle'); this.$beastInfo = q('#ab-beast-info'); this.$beastWarn = q('#ab-beast-warn'); this.$beastKeep = q('#ab-beast-keep'); this.$beastHatch = q('#ab-beast-hatch'); this.$beastRelease = q('#ab-beast-release'); this.$beastStatus = q('#ab-beast-status');
      this.$tower = q('#ab-tower-toggle'); this.$towerStatus = q('#ab-tower-status');
      this.$lUser = q('#ab-login-user'); this.$lPass = q('#ab-login-pass'); this.$lOn = q('#ab-login-on'); this.$lShow = q('#ab-login-show'); this.$lStatus = q('#ab-login-status'); this.$resume = q('#ab-resume'); this.$resumeInfo = q('#ab-resume-info');
      this.$xh = q('#ab-xh-toggle'); this.$xhMap = q('#ab-xh-map'); this.$xhDur = q('#ab-xh-dur'); this.$xhStatus = q('#ab-xh-status'); this.$xhInfo = q('#ab-xh-info');
      this.$um = q('#ab-um-toggle'); this.$umGate = q('#ab-um-gate'); this.$umStatus = q('#ab-um-status');
      this.$war = q('#ab-war-toggle'); this.$warTerr = q('#ab-war-terr'); this.$warInfo = q('#ab-war-info'); this.$warStatus = q('#ab-war-status');
      this.$drag = q('#ab-drag'); this.$body = q('#ab-body'); this.$ctrl = q('#ab-ctrl');
      this.live = {}; this.sumText = {}; // trạng thái bật + dòng trạng thái ngắn của từng dòng trong thang
      this.$min = q('#ab-min'); this.$minCtrl = q('#ab-min-ctrl'); this.$minLog = q('#ab-min-log'); this.$ui = q('#ab-ui');
      this.$stripRun = q('#ab-strip-run');
      this.$stripRun.addEventListener('click', e => { const b = e.target.closest('[data-stop]'); const sw = b && this.panel.querySelector(`.ab-row[data-key="${b.dataset.stop}"] .ab-sw`); if (sw) sw.click(); }); this.$stripTix = q('#ab-strip-tix'); this.$stripLog = q('#ab-strip-log'); this.$railN = q('#ab-rail-n');
      this.tix = {}; this.$req = q('#ab-req'); this.$stripReq = q('#ab-strip-req');
      this.dual = {}; // 'hp-boss' | 'mp-farm' | 'mg-um' | 'hg-tower' ... → DualSlider
      for (const sp of DUAL_SPECS) for (const k of sp.modes) this.dual[`${sp.p}-${k}`] = new DualSlider({ loEl: q(`#ab-${sp.p}-${k}-lo`), hiEl: q(`#ab-${sp.p}-${k}-hi`), defLo: sp.lo, defHi: sp.hi, storage, key: null, min: 5, max: 95, step: 5, tickValues: Array.from({ length: 19 }, (_, i) => 5 + i * 5), labelStep: 2 });
      this.healSliders = {};
      for (const k of MODES5) this.healSliders[k] = new DualSlider({ loEl: q(`#ab-hs-${k}-lo`), hiEl: q(`#ab-hs-${k}-hi`), defLo: Math.round(CFG.HEAL_BELOW_PCT * 100), defHi: Math.round(CFG.HEAL_DEFAULT_HIGH * 100), storage, key: null, min: 5, max: 95, step: 5, tickValues: Array.from({ length: 19 }, (_, i) => 5 + i * 5), labelStep: 2 });
      this.$hpNow = q('#ab-hp-now');
      this.hpNow = new SingleSlider({ el: q('#ab-hpnow'), defVal: 50, storage, key: 'tt-auto-boss-hpnow' });
      this.labels = {
        boss: ['▶ Bật boss', '■ Tắt boss'], farm: ['▶ Bật tầm bảo', '■ Tắt tầm bảo'], hunt: ['▶ Bật săn yêu', '■ Tắt săn yêu'],
        alchemy: ['▶ Bật luyện đan', '■ Tắt luyện đan'],
        um: ['▶ Bật U Minh Cốc', '■ Tắt U Minh Cốc'],
        tower: ['▶ Bật leo tháp', '■ Tắt leo tháp'],
        xh: ['▶ Bật xuất hồn', '■ Tắt xuất hồn'],
        garden: ['▶ Bật Linh Điền', '■ Tắt Linh Điền'],
        beast: ['▶ Bật tự động yêu thú', '■ Tắt tự động yêu thú'],
        war: ['▶ Bật Tông Chiến', '■ Tắt Tông Chiến'],
      };
    }

    static panelCount() { return document.querySelectorAll('#tt-auto-boss-panel').length; }

    build() {
      const panel = document.createElement('div');
      // font Be Vietnam Pro (thiết kế cho tiếng Việt); nếu trang chặn tải font thì dùng font hệ thống
      try {
        if (!document.getElementById('tt-ab-font')) {
          const l = document.createElement('link'); l.id = 'tt-ab-font'; l.rel = 'stylesheet';
          l.href = 'https://fonts.googleapis.com/css2?family=Be+Vietnam+Pro:wght@400;500&display=swap';
          (document.head || document.documentElement).appendChild(l);
        }
      } catch (_) {}
      // ô tích + thanh trượt đôi x% – y% của từng chế độ (đan hồi HP, đan hồi MP, ngưỡng MP, ngưỡng HP); p = tiền tố id, mặc định lấy từ DUAL_SPECS
      const dual = (p, k, tip, rangeTip, text) => {
        const sp = DUAL_SPECS.find(x => x.p === p), id = `ab-${p}-${k}`;
        return `
        <label class="ab-chk" title="${tip}"><input type="checkbox" id="${id}"${sp.checked ? ' checked' : ''}><span>${text(`<span class="ab-n" id="${id}-lo-t">${sp.lo}</span>`, `<span class="ab-n" id="${id}-hi-t">${sp.hi}</span>`)}</span></label>
        <div id="${id}-box" class="ab-hpbox"${sp.checked ? '' : ' style="display:none"'}>
          <div class="ab-range" title="${rangeTip}">
            <div class="ab-track"><div class="ab-fill"></div></div>
            <input type="range" class="ab-lo" id="${id}-lo" min="5" max="95" step="5" value="${sp.lo}">
            <input type="range" class="ab-hi" id="${id}-hi" min="5" max="95" step="5" value="${sp.hi}">
          </div>
          <div class="ab-ticks" id="${id}-ticks"></div>
        </div>`;
      };
      const HP_TIP = 'Khi HP < x% thì dùng đan hồi HP đã chọn ở mục Đan, dùng liên tục cho tới khi HP >= y%. Hết đan / không bật thì mới dùng chiêu heal trong bộ skill.';
      const MP_TIP = 'Khi MP ≤ x% thì dùng đan hồi MP đã chọn ở mục Đan, dùng liên tục cho tới khi MP >= y%.';
      const hp = k => dual('hp', k, HP_TIP, 'Nút vàng (x): bắt đầu dùng đan khi HP < mức này. Nút xanh (y): ngừng dùng đan khi HP >= mức này. 5% – 95%, mỗi nấc 5%, hai nút không được trùng nhau.', (l, h) => `Dùng đan hồi HP từ ${l}% đến ${h}%`);
      const mp = k => dual('mp', k, MP_TIP, 'Nút vàng (x): bắt đầu dùng đan khi MP ≤ mức này. Nút xanh (y): ngừng dùng đan khi MP >= mức này. 5% – 95%, mỗi nấc 5%, hai nút không được trùng nhau.', (l, h) => `Dùng đan hồi MP từ ${l}% đến ${h}%`);
      // ngưỡng MP / HP của từng chế độ (tầm bảo, săn yêu, leo tháp, U Minh Cốc): tạm dừng x% – chạy tiếp y%
      const GT_TIP = { MP: 'Bật: MP ≤ x% thì không mở trận mới (U Minh Cốc: không vào), dùng đan hồi MP của chế độ nếu đã bật, không thì chờ MP tự hồi; chạy tiếp khi MP > y%. Tắt: không kiểm tra ngưỡng MP.',
        HP: 'Bật: HP ≤ x% thì không mở trận mới (U Minh Cốc: không vào vì trong đó HP không tự hồi theo thời gian), dùng đan hồi HP của chế độ nếu đã bật, không thì chờ HP tự hồi; chạy tiếp khi HP > y%. Tắt: không kiểm tra ngưỡng HP.' };
      const gate = (p, w) => k => dual(p, k, GT_TIP[w], `Nút vàng (x): ${w} còn ≤ mức này thì tạm dừng. Nút xanh (y): vượt mức này thì chạy tiếp. 5% – 95%, mỗi nấc 5%, hai nút không được trùng nhau.`, (l, h) => `Ngưỡng ${w}: tạm dừng khi ≤ ${l}%, chạy tiếp khi &gt; ${h}%`);
      const gtM = gate('mg', 'MP'), gtH = gate('hg', 'HP'), gt = k => gtM(k) + gtH(k);
      // mức hồi máu của CHIÊU hồi máu (x% – y%), từng chế độ; luôn hiện (không có ô bật: chiêu heal vốn tự dùng khi HP thấp)
      const hs = k => `
        <div class="ab-hs" title="Chiêu hồi máu trong bộ skill: dùng khi HP < x%, dùng liên tục cho tới khi HP >= y%. Nút vàng (x) và nút xanh (y), 5% – 95%, mỗi nấc 5%. Nếu đan hồi HP của chế độ này đang lo việc hồi máu thì chiêu heal không dùng.">
          <div class="ab-hstext">Chiêu hồi máu: dùng khi HP &lt; <span class="ab-n" id="ab-hs-${k}-lo-t">10</span>%, dừng khi HP ≥ <span class="ab-n" id="ab-hs-${k}-hi-t">15</span>%</div>
          <div><div class="ab-range">
            <div class="ab-track"><div class="ab-fill"></div></div>
            <input type="range" class="ab-lo" id="ab-hs-${k}-lo" min="5" max="95" step="5" value="10">
            <input type="range" class="ab-hi" id="ab-hs-${k}-hi" min="5" max="95" step="5" value="15">
          </div><div class="ab-ticks"></div></div>
        </div>`;
      // một dòng của thang: nút tròn (số thứ tự ưu tiên), tên + trạng thái, công tắc nhanh, mũi tên mở / gập phần cài đặt
      const pageHd = name => `<div class="ab-page-hd"><button type="button" class="ab-back" aria-label="Quay lại danh sách">‹ Quay lại</button><span class="ab-pt">${name}</span></div>`;
      const row = (key, rank, name, body) => `
      <div class="ab-row" data-key="${key}" data-open="0" data-on="0">
        <div class="ab-head" role="button" tabindex="0" aria-expanded="false">
          <span class="ab-node">${rank}</span><i class="ab-seal" aria-hidden="true"></i>
          <span class="ab-title"><span class="ab-name">${name}</span><span class="ab-sum" data-sum="${key}"></span></span>
          <span class="ab-sw" role="switch" tabindex="0" aria-checked="false" aria-label="Bật / tắt ${name}" data-sw="${key}"><i></i></span>
          <span class="ab-chev" aria-hidden="true"></span>
        </div>
        <div class="ab-bodywrap ab-page">${pageHd(name)}<div class="ab-bodyin">${body}</div></div>
      </div>`;
      let sectN = 0;
      const sect = (title, hint, body) => `
      <section class="ab-sect" data-key="s${++sectN}" data-open="0">
        <h3 role="button" tabindex="0">${title}${hint ? ` <small>${hint}</small>` : ''}</h3>
        <div class="ab-sbody ab-page">${pageHd(title)}<div class="ab-sin">${body}</div></div>
      </section>`;
      panel.id = 'tt-auto-boss-panel';
      panel.innerHTML = `
    <style>
      #tt-auto-boss-panel{--ink:#131a1d;--ink2:#1a2327;--ink3:#232e33;--line:#33434a;--paper:#e5ede7;--mute:#8da09a;--jade:#72d8b0;--jade-d:#2c8a69;--cin:#ec5f45;--gold:#e0b95c;--fs-s:12px;--fs-m:13px;--fs-l:15px;
        position:fixed;right:12px;bottom:12px;z-index:999999;width:348px;max-width:calc(100vw - 16px);max-height:calc(100vh - 24px);display:flex;flex-direction:column;box-sizing:border-box;
        background:var(--ink);color:var(--paper);font:400 var(--fs-m)/1.45 "Be Vietnam Pro",system-ui,"Segoe UI",Roboto,sans-serif;letter-spacing:0;border:1px solid var(--line);border-radius:12px;
        box-shadow:0 14px 36px #000b,0 0 0 1px #0007;overflow:hidden;color-scheme:dark}
      #tt-auto-boss-panel *{box-sizing:border-box}
      #tt-auto-boss-panel button,#tt-auto-boss-panel select,#tt-auto-boss-panel input{font:inherit}
      #tt-auto-boss-panel :focus-visible{outline:2px solid var(--jade);outline-offset:1px}
      #tt-auto-boss-panel #ab-drag{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:8px 10px;background:var(--ink2);border-bottom:1px solid var(--line);cursor:move;user-select:none;touch-action:none}
      #tt-auto-boss-panel .ab-brand{display:flex;align-items:center;gap:8px;min-width:0}
      #tt-auto-boss-panel .ab-brand b{font-weight:500;font-size:var(--fs-l);line-height:1}
      #tt-auto-boss-panel .ab-n{color:#fff;font-variant-numeric:tabular-nums}
      #tt-auto-boss-panel .ab-pt{font-weight:500;font-size:var(--fs-l);line-height:1.2}
      #tt-auto-boss-panel .ab-brand small{color:var(--mute);font-size:var(--fs-s)}
      #tt-auto-boss-panel .ab-tbs{display:flex;gap:4px}
      #tt-auto-boss-panel .ab-tb{cursor:pointer;min-width:26px;height:24px;padding:0 6px;line-height:1;background:var(--ink3);color:var(--paper);border:1px solid var(--line);border-radius:6px}
      #tt-auto-boss-panel .ab-tb:hover{border-color:var(--jade-d)}
      #tt-auto-boss-panel .ab-tb.off{opacity:.45;text-decoration:line-through}
      #tt-auto-boss-panel.min{width:auto;min-width:210px}
      #tt-auto-boss-panel.min #ab-drag{border-bottom:0}
      #tt-auto-boss-panel #ab-body{display:flex;flex-direction:column;overflow:hidden;min-height:0;flex:1 1 auto}
      #tt-auto-boss-panel #ab-ctrl{overflow-y:auto;overscroll-behavior:contain;min-height:0;flex:1 1 auto;scrollbar-width:thin;scrollbar-color:var(--line) transparent}
      /* tab */
      #tt-auto-boss-panel .ab-tabs{position:sticky;top:0;z-index:3;display:flex;background:var(--ink);border-bottom:1px solid var(--line)}
      #tt-auto-boss-panel .ab-tab{flex:1;padding:9px 4px 8px;background:none;border:0;border-bottom:2px solid transparent;color:var(--mute);cursor:pointer;font-weight:500;font-size:var(--fs-m)}
      #tt-auto-boss-panel .ab-tab:hover{color:var(--paper)}
      #tt-auto-boss-panel .ab-tab[aria-selected="true"]{color:var(--jade);border-bottom-color:var(--jade);font-weight:500}
      #tt-auto-boss-panel .ab-pane{display:none;padding:10px 12px 14px}
      #tt-auto-boss-panel .ab-pane.on{display:block}
      #tt-auto-boss-panel .ab-note{margin:0 0 8px;color:var(--mute);font-size:var(--fs-s);line-height:1.45}
      /* thang ưu tiên */
      #tt-auto-boss-panel .ab-ladder{position:relative}
      #tt-auto-boss-panel .ab-ladder::before{content:"";position:absolute;left:11px;top:16px;bottom:16px;width:2px;background:var(--line);border-radius:1px}
      #tt-auto-boss-panel .ab-row{position:relative}
      #tt-auto-boss-panel .ab-row+.ab-row{margin-top:2px}
      #tt-auto-boss-panel .ab-head{display:flex;align-items:center;gap:10px;padding:7px 4px 7px 0;cursor:pointer;border-radius:8px}
      #tt-auto-boss-panel .ab-head:hover .ab-name{color:#fff}
      #tt-auto-boss-panel .ab-node{position:relative;z-index:1;flex:0 0 24px;width:24px;height:24px;border-radius:50%;display:grid;place-items:center;background:var(--ink);border:2px solid var(--line);color:var(--mute);font-weight:500;font-size:var(--fs-s);transition:background .2s,border-color .2s,color .2s}
      #tt-auto-boss-panel .ab-row[data-on="1"] .ab-node{background:var(--jade);border-color:var(--jade);color:var(--ink);animation:ab-breathe 2.6s ease-in-out infinite}
      #tt-auto-boss-panel .ab-title{flex:1;min-width:0;display:flex;flex-direction:column}
      #tt-auto-boss-panel .ab-name{font-weight:500;font-size:var(--fs-l);line-height:1.3;transition:color .15s}
      #tt-auto-boss-panel .ab-sum{color:var(--mute);font-size:var(--fs-s);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      #tt-auto-boss-panel .ab-row[data-on="1"] .ab-sum{color:var(--jade)}
      #tt-auto-boss-panel .ab-sw{flex:0 0 34px;width:34px;height:20px;border-radius:10px;background:var(--ink3);border:1px solid var(--line);position:relative;cursor:pointer;transition:background .2s,border-color .2s}
      #tt-auto-boss-panel .ab-sw i{position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:var(--mute);transition:transform .2s,background .2s}
      #tt-auto-boss-panel .ab-row[data-on="1"] .ab-sw{background:var(--jade-d);border-color:var(--jade-d)}
      #tt-auto-boss-panel .ab-row[data-on="1"] .ab-sw i{transform:translateX(14px);background:#fff}
      #tt-auto-boss-panel .ab-chev{flex:0 0 8px;width:8px;height:8px;border-right:2px solid var(--mute);border-bottom:2px solid var(--mute);transform:rotate(45deg);margin:0 4px 3px 2px;transition:transform .2s}
      #tt-auto-boss-panel .ab-row[data-open="1"] .ab-chev{transform:rotate(-135deg);margin-bottom:-3px}
      #tt-auto-boss-panel .ab-bodywrap{display:grid;grid-template-rows:0fr;transition:grid-template-rows .22s ease}
      #tt-auto-boss-panel .ab-row[data-open="1"] .ab-bodywrap{grid-template-rows:1fr}
      #tt-auto-boss-panel .ab-bodyin{overflow:hidden;min-height:0;padding-left:34px}
      #tt-auto-boss-panel .ab-row[data-open="1"] .ab-bodyin{padding-bottom:10px}
      #tt-auto-boss-panel .ab-bodyin>*+*{margin-top:8px}
      @keyframes ab-breathe{0%,100%{box-shadow:0 0 0 0 #72d8b000}50%{box-shadow:0 0 0 5px #72d8b02e}}
      /* nhóm thường (tab Hành trang) */
      #tt-auto-boss-panel .ab-sect+.ab-sect{margin-top:14px;padding-top:12px;border-top:1px solid var(--line)}
      #tt-auto-boss-panel .ab-sect h3{margin:0 0 8px;font-weight:500;font-size:var(--fs-l);line-height:1.3;display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}
      #tt-auto-boss-panel .ab-sect h3 small{font-weight:400;font-size:var(--fs-s);line-height:1.3;color:var(--mute)}
      #tt-auto-boss-panel .ab-sect>*+*{margin-top:8px}
      /* điều khiển */
      #tt-auto-boss-panel select{width:100%;min-width:0;background:var(--ink2);color:var(--paper);border:1px solid var(--line);border-radius:6px;padding:6px 8px;text-overflow:ellipsis}
      #tt-auto-boss-panel select:hover{border-color:#47606a}
      #tt-auto-boss-panel input[type=number]{width:100%;min-width:0;background:var(--ink2);color:var(--paper);border:1px solid var(--line);border-radius:6px;padding:6px 8px}
      #tt-auto-boss-panel .ab-line{display:flex;gap:6px;align-items:center}
      #tt-auto-boss-panel .ab-line>span.ab-lbl{flex:0 0 28px;color:var(--mute)}
      #tt-auto-boss-panel .ab-chk{display:flex;align-items:flex-start;gap:8px;cursor:pointer;line-height:1.4}
      #tt-auto-boss-panel input[type=checkbox]{accent-color:var(--jade);width:15px;height:15px;margin:1px 0 0;flex:0 0 auto;cursor:pointer}
      #tt-auto-boss-panel .ab-field{display:block;color:var(--mute)}
      #tt-auto-boss-panel .ab-field>.ab-in,#tt-auto-boss-panel .ab-field>.ab-line,#tt-auto-boss-panel .ab-field>select{margin-top:4px}
      #tt-auto-boss-panel .ab-in{width:100%;min-width:0;height:32px;padding:0 10px;background:var(--ink2);color:var(--paper);border:1px solid var(--line);border-radius:6px}
      #tt-auto-boss-panel .ab-in:hover{border-color:#47606a}
      #tt-auto-boss-panel .ab-status[data-kind=err]{color:#ff7a66}
      #tt-auto-boss-panel .ab-status[data-kind=warn]{color:var(--gold)}
      #tt-auto-boss-panel .ab-chips{display:flex;gap:6px}
      #tt-auto-boss-panel .ab-chip{position:relative;flex:1;text-align:center;padding:5px 0;border:1px solid var(--line);border-radius:6px;cursor:pointer;color:var(--mute);background:var(--ink2);transition:background .15s,color .15s,border-color .15s}
      #tt-auto-boss-panel .ab-chip input{position:absolute;opacity:0;inset:0;margin:0;cursor:pointer}
      #tt-auto-boss-panel .ab-chip:has(input:checked){background:#1d3a32;border-color:var(--jade-d);color:var(--jade)}
      #tt-auto-boss-panel .ab-chip:has(input:focus-visible){outline:2px solid var(--jade);outline-offset:1px}
      #tt-auto-boss-panel .ab-act{width:100%;height:32px;cursor:pointer;background:transparent;color:var(--jade);border:1px solid var(--jade-d);border-radius:6px;font-weight:500;transition:background .15s,color .15s,border-color .15s}
      #tt-auto-boss-panel .ab-act:hover{background:#72d8b01a}
      #tt-auto-boss-panel .ab-act[data-on="1"]{color:var(--cin);border-color:var(--cin)}
      #tt-auto-boss-panel .ab-act[data-on="1"]:hover{background:#ec5f451a}
      #tt-auto-boss-panel .ab-act:disabled,#tt-auto-boss-panel .ab-mini:disabled{opacity:.5;cursor:default}
      #tt-auto-boss-panel .ab-mini{flex:0 0 auto;min-width:30px;height:30px;padding:0 8px;cursor:pointer;background:var(--ink3);color:var(--paper);border:1px solid var(--line);border-radius:6px;white-space:nowrap}
      #tt-auto-boss-panel .ab-mini:hover:not(:disabled){border-color:var(--jade-d)}
      #tt-auto-boss-panel .ab-mini[data-act=lock]{padding:0 6px}
      #tt-auto-boss-panel .ab-mini[data-act=lock][data-on="1"]{border-color:var(--gold)}
      #tt-auto-boss-panel .ab-subs{display:flex;gap:6px}
      #tt-auto-boss-panel .ab-sub{flex:1;padding:5px 6px;cursor:pointer;background:var(--ink2);color:var(--mute);border:1px solid var(--line);border-radius:6px;transition:opacity .15s,border-color .15s,color .15s}
      #tt-auto-boss-panel .ab-sub[data-on="1"]{border-color:var(--jade-d);color:var(--jade)}
      #tt-auto-boss-panel .ab-sub[data-live="0"]{opacity:.6}
      #tt-auto-boss-panel .ab-status{color:var(--mute);font-size:var(--fs-s);line-height:1.45}
      #tt-auto-boss-panel .ab-status:empty{display:none}
      #tt-auto-boss-panel .ab-hpbox{padding:8px 10px;background:var(--ink2);border-radius:8px}
      #tt-auto-boss-panel .ab-hprow{display:flex;justify-content:space-between;color:var(--mute)}
      #tt-auto-boss-panel .ab-hprow b{color:var(--paper)}
      #tt-auto-boss-panel .ab-skillrow{display:flex;gap:6px;align-items:center}
      #tt-auto-boss-panel .ab-skillrow+.ab-skillrow,#tt-auto-boss-panel #ab-swap-pool-list select+select{margin-top:6px}
      #tt-auto-boss-panel .ab-skill{flex:1;min-width:0;padding:6px 8px;background:var(--ink2);border:1px solid var(--line);border-radius:6px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      #tt-auto-boss-panel #ab-skills{margin-top:10px}
      #tt-auto-boss-panel .ab-skill-off{opacity:.55;text-decoration:line-through}
      #tt-auto-boss-panel .ab-skill-on{border-style:dashed;border-color:var(--jade-d)}
      /* thanh trượt */
      #tt-auto-boss-panel .ab-range{position:relative;height:24px;margin:2px 0 0}
      #tt-auto-boss-panel .ab-range .ab-track{position:absolute;left:8px;right:8px;top:10px;height:4px;background:var(--ink3);border-radius:2px;box-shadow:inset 0 0 0 1px var(--line)}
      #tt-auto-boss-panel .ab-range .ab-fill{position:absolute;top:0;height:4px;background:var(--jade-d);border-radius:2px}
      #tt-auto-boss-panel .ab-range input{position:absolute;left:0;top:0;width:100%;height:24px;margin:0;background:none;pointer-events:none;-webkit-appearance:none;appearance:none}
      #tt-auto-boss-panel .ab-range input::-webkit-slider-runnable-track{background:transparent;height:24px}
      #tt-auto-boss-panel .ab-range input::-moz-range-track{background:transparent;height:24px}
      #tt-auto-boss-panel .ab-range input::-webkit-slider-thumb{pointer-events:auto;-webkit-appearance:none;appearance:none;width:16px;height:16px;margin-top:4px;border-radius:50%;border:2px solid var(--ink);cursor:grab;box-shadow:0 0 0 1px #fff6}
      #tt-auto-boss-panel .ab-range input::-moz-range-thumb{pointer-events:auto;width:12px;height:12px;border-radius:50%;border:2px solid var(--ink);cursor:grab}
      #tt-auto-boss-panel .ab-lo::-webkit-slider-thumb{background:var(--gold)}#tt-auto-boss-panel .ab-lo::-moz-range-thumb{background:var(--gold)}
      #tt-auto-boss-panel .ab-hi::-webkit-slider-thumb{background:var(--jade)}#tt-auto-boss-panel .ab-hi::-moz-range-thumb{background:var(--jade)}
      #tt-auto-boss-panel .ab-ticks{position:relative;height:18px;font-size:var(--fs-s);line-height:1.2;color:var(--mute);font-variant-numeric:tabular-nums}
      #tt-auto-boss-panel .ab-ticks span::before{content:"";display:block;width:1px;height:4px;margin:0 auto 1px;background:var(--line)}
      #tt-auto-boss-panel .ab-ticks span{position:absolute;transform:translateX(-50%)}
      /* nhật ký */
      #tt-auto-boss-panel #ab-log{flex:0 0 auto;height:min(168px,26vh);overflow:auto;padding:8px 10px;background:#0d1214;border-top:1px solid var(--line);white-space:pre-wrap;font-size:var(--fs-m);line-height:1.45;font-variant-numeric:tabular-nums;scrollbar-width:thin;scrollbar-color:var(--line) transparent}
      /* ===== giao diện màn hình nhỏ (7 inch, cảm ứng): ngăn kéo bên phải + thanh thu gọn; chỉ áp dụng khi bảng có class "cp" ===== */
      #tt-auto-boss-panel .ab-page-hd,#tt-auto-boss-panel .ab-seal,#tt-auto-boss-panel #ab-rail,#tt-auto-boss-panel #ab-strip{display:none}
      #tt-auto-boss-panel .ab-sin>*+*{margin-top:8px}
      #tt-auto-boss-panel.cp{left:auto!important;top:0!important;right:0!important;bottom:0!important;width:360px;max-width:100vw;height:100vh;height:100dvh;max-height:none;border-radius:0;border-width:0 0 0 1px;--abh:14px;--fs-s:12.5px;--fs-m:14px;--fs-l:16px;touch-action:manipulation}
      #tt-auto-boss-panel.cp.rail{width:56px!important}
      #tt-auto-boss-panel.cp.rail #ab-drag,#tt-auto-boss-panel.cp.rail #ab-body{display:none!important}
      #tt-auto-boss-panel.cp.rail #ab-rail{display:flex;flex-direction:column;align-items:stretch;height:100%;background:var(--ink2)}
      #tt-auto-boss-panel.cp #ab-body{display:flex!important}
      #tt-auto-boss-panel.cp #ab-ctrl{display:block!important}
      #tt-auto-boss-panel.cp #ab-drag{height:48px;padding:0 6px 0 12px;cursor:default;touch-action:auto}
      #tt-auto-boss-panel.cp .ab-tb{min-width:44px;height:40px;font-size:16px}
      #tt-auto-boss-panel.cp #ab-min-ctrl{display:none}
      #tt-auto-boss-panel.cp .ab-rb{flex:0 0 auto;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:5px;height:64px;padding:0;background:none;border:0;border-bottom:1px solid var(--line);color:var(--mute);font-size:var(--fs-s);cursor:pointer;-webkit-tap-highlight-color:transparent}
      #tt-auto-boss-panel.cp .ab-rb i{width:14px;height:14px;border-radius:50%;border:2px solid var(--line);background:var(--ink);transition:background .2s,border-color .2s}
      #tt-auto-boss-panel.cp .ab-rb[data-on="1"]{color:var(--paper)}
      #tt-auto-boss-panel.cp .ab-rb[data-on="1"] i{background:var(--jade);border-color:var(--jade)}
      #tt-auto-boss-panel.cp #ab-rail-open{height:56px;font-size:22px;color:var(--paper)}
      #tt-auto-boss-panel.cp #ab-rail-n{margin-top:auto;padding:12px 0;text-align:center;color:var(--jade);font-weight:500;font-size:var(--fs-l);line-height:1}
      #tt-auto-boss-panel.cp #ab-strip{display:block;flex:0 0 auto;padding:6px 12px 2px;background:var(--ink2);border-bottom:1px solid var(--line)}
      #tt-auto-boss-panel.cp .ab-srow{display:flex;justify-content:space-between;gap:8px;font-size:var(--fs-s);line-height:1.4}
      #tt-auto-boss-panel.cp #ab-strip-run{min-width:0;display:flex;flex-wrap:wrap;gap:4px;color:var(--jade)}
      #tt-auto-boss-panel .ab-run{height:32px;padding:0 10px;cursor:pointer;color:var(--jade);background:#17312b;border:1px solid var(--jade-d);border-radius:16px;font-size:var(--fs-s);white-space:nowrap}
      #tt-auto-boss-panel .ab-run:hover{border-color:var(--cin);color:var(--cin)}
      #tt-auto-boss-panel .ab-more{border:1px solid var(--line);border-radius:8px;background:var(--ink2)}
      #tt-auto-boss-panel .ab-more>summary{cursor:pointer;min-height:36px;display:flex;align-items:center;padding:0 10px;color:var(--mute);list-style:none}
      #tt-auto-boss-panel .ab-more>summary::-webkit-details-marker{display:none}
      #tt-auto-boss-panel .ab-more>summary::after{content:"";margin-left:auto;width:7px;height:7px;border-right:2px solid var(--mute);border-bottom:2px solid var(--mute);transform:rotate(45deg);transition:transform .15s}
      #tt-auto-boss-panel .ab-more[open]>summary::after{transform:rotate(-135deg)}
      #tt-auto-boss-panel .ab-more[open]{padding-bottom:10px}
      #tt-auto-boss-panel .ab-more>*:not(summary){margin:8px 10px 0}
      #tt-auto-boss-panel.cp #ab-strip-run[data-n="0"]{color:var(--mute)}
      #tt-auto-boss-panel.cp #ab-strip-tix{flex:0 0 auto;color:var(--gold);white-space:nowrap;font-variant-numeric:tabular-nums}
      #tt-auto-boss-panel.cp #ab-strip-log{display:block;width:100%;min-height:34px;padding:2px 0 4px;text-align:left;background:none;border:0;color:var(--mute);font-size:var(--fs-s);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;cursor:pointer}
      #tt-auto-boss-panel.cp .ab-tab{min-height:48px}
      /* màn nhỏ: vùng chạm tối thiểu 44px cho các điều khiển trong trang cài đặt */
      #tt-auto-boss-panel.cp select,#tt-auto-boss-panel.cp .ab-in,#tt-auto-boss-panel.cp .ab-act,#tt-auto-boss-panel.cp .ab-mini,#tt-auto-boss-panel.cp input[type=number]{min-height:44px}
      #tt-auto-boss-panel.cp .ab-chip{padding:11px 0}
      #tt-auto-boss-panel.cp .ab-chk{min-height:36px;align-items:center}
      #tt-auto-boss-panel.cp input[type=checkbox]{width:22px;height:22px;margin:0}
      #tt-auto-boss-panel.cp .ab-more>summary{min-height:44px}
      #tt-auto-boss-panel.cp .ab-range{height:36px}
      #tt-auto-boss-panel.cp .ab-range .ab-track{top:16px}
      #tt-auto-boss-panel.cp .ab-range input,#tt-auto-boss-panel.cp .ab-range input::-webkit-slider-runnable-track{height:36px}
      #tt-auto-boss-panel.cp .ab-range input::-moz-range-track{height:36px}
      #tt-auto-boss-panel.cp .ab-range input::-webkit-slider-thumb{width:24px;height:24px;margin-top:6px}
      #tt-auto-boss-panel.cp .ab-range input::-moz-range-thumb{width:20px;height:20px}
      #tt-auto-boss-panel.cp .ab-pane{padding:10px 10px 16px}
            #tt-auto-boss-panel.cp .ab-ladder{display:grid;grid-template-columns:1fr 1fr;gap:8px}
      #tt-auto-boss-panel.cp .ab-ladder{position:static}
      #tt-auto-boss-panel.cp .ab-ladder::before{display:none}
      #tt-auto-boss-panel.cp .ab-row{position:static;margin:0!important}
      #tt-auto-boss-panel.cp .ab-node,#tt-auto-boss-panel.cp .ab-chev{display:none}
      #tt-auto-boss-panel.cp .ab-head{display:grid;grid-template-columns:1fr auto;align-items:end;gap:6px;min-height:92px;padding:10px;background:var(--ink2);border:1px solid var(--line);border-radius:10px;-webkit-tap-highlight-color:transparent;transition:background .2s,border-color .2s}
      #tt-auto-boss-panel.cp .ab-title{grid-column:1 / -1;align-self:start}
            #tt-auto-boss-panel.cp .ab-sum{white-space:normal;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;line-height:1.35}
      #tt-auto-boss-panel.cp .ab-sw{grid-column:2;grid-row:2;flex:none;width:56px;height:32px;border-radius:16px}
      #tt-auto-boss-panel.cp .ab-sw i{top:3px;left:3px;width:24px;height:24px}
      #tt-auto-boss-panel.cp .ab-row[data-on="1"] .ab-sw i{transform:translateX(24px)}
      #tt-auto-boss-panel.cp .ab-row[data-on="1"] .ab-head{border-color:var(--jade-d);background:#17312b}
      #tt-auto-boss-panel.cp .ab-seal{grid-column:1;grid-row:2;justify-self:start;align-self:center;width:22px;height:22px;border-radius:5px;background:radial-gradient(circle,#f3ebe0 0 34%,transparent 36%),var(--cin)}
      #tt-auto-boss-panel.cp .ab-row[data-on="1"] .ab-seal{display:block}
      #tt-auto-boss-panel.cp.ready .ab-row[data-on="1"] .ab-seal{animation:ab-stamp .3s cubic-bezier(.2,.9,.3,1.35)}
      @keyframes ab-stamp{from{transform:scale(2.2) rotate(-16deg);opacity:0}55%{opacity:1}to{transform:none;opacity:1}}
      @keyframes ab-slide{from{transform:translateX(28px);opacity:0}to{transform:none;opacity:1}}
      #tt-auto-boss-panel.cp .ab-pane[data-pane="kit"].on,#tt-auto-boss-panel.cp .ab-pane[data-pane="acct"].on{display:grid;grid-template-columns:1fr 1fr;gap:8px;align-content:start}
      #tt-auto-boss-panel.cp .ab-sect+.ab-sect{margin:0;padding:0;border:0}
      #tt-auto-boss-panel.cp .ab-sect h3{display:flex;flex-direction:column;align-items:flex-start;justify-content:flex-start;gap:4px;margin:0;min-height:92px;padding:10px;background:var(--ink2);border:1px solid var(--line);border-radius:10px;cursor:pointer;-webkit-tap-highlight-color:transparent}
      #tt-auto-boss-panel.cp .ab-sect h3 small{line-height:1.35;color:var(--mute)}
      #tt-auto-boss-panel.cp .ab-bodywrap,#tt-auto-boss-panel.cp .ab-sbody{display:none}
      #tt-auto-boss-panel.cp .ab-row[data-open="1"]>.ab-bodywrap,#tt-auto-boss-panel.cp .ab-sect[data-open="1"]>.ab-sbody{display:flex;flex-direction:column;position:absolute;left:0;right:0;top:48px;bottom:0;z-index:6;background:var(--ink);animation:ab-slide .2s ease-out}
      #tt-auto-boss-panel.cp .ab-page-hd{display:flex;align-items:center;gap:10px;flex:0 0 auto;min-height:56px;padding:6px 10px;background:var(--ink2);border-bottom:1px solid var(--line)}
            #tt-auto-boss-panel.cp .ab-back{min-width:44px;height:44px;padding:0 14px;background:var(--ink3);color:var(--paper);border:1px solid var(--line);border-radius:8px;cursor:pointer}
      #tt-auto-boss-panel.cp .ab-bodyin,#tt-auto-boss-panel.cp .ab-sin{flex:1 1 auto;min-height:0;overflow-y:auto;overscroll-behavior:contain;padding:12px 14px 24px!important;scrollbar-width:thin;scrollbar-color:var(--line) transparent}
      #tt-auto-boss-panel.cp select,#tt-auto-boss-panel.cp input[type=number],#tt-auto-boss-panel.cp .ab-in{height:44px;min-height:44px;padding:0 10px}
      #tt-auto-boss-panel.cp .ab-act{height:48px;border-radius:8px}
      #tt-auto-boss-panel.cp .ab-mini{min-width:44px;height:44px}
      #tt-auto-boss-panel.cp .ab-chk{align-items:center;gap:4px;min-height:44px}
      #tt-auto-boss-panel.cp input[type=checkbox]{width:24px;height:24px;margin:0 8px 0 0}
      #tt-auto-boss-panel.cp .ab-chip{display:flex;align-items:center;justify-content:center;min-height:44px;padding:0}
      #tt-auto-boss-panel.cp .ab-sub{min-height:44px}
      #tt-auto-boss-panel.cp .ab-line>span.ab-lbl{flex-basis:34px}
      #tt-auto-boss-panel.cp .ab-skill{padding:10px 8px}
            #tt-auto-boss-panel.cp .ab-range{height:40px}
      #tt-auto-boss-panel.cp .ab-range .ab-track{left:14px;right:14px;top:18px}
      #tt-auto-boss-panel.cp .ab-range input{height:40px}
      #tt-auto-boss-panel.cp .ab-range input::-webkit-slider-runnable-track{height:40px}
      #tt-auto-boss-panel.cp .ab-range input::-moz-range-track{height:40px}
      #tt-auto-boss-panel.cp .ab-range input::-webkit-slider-thumb{width:28px;height:28px;margin-top:6px}
      #tt-auto-boss-panel.cp .ab-range input::-moz-range-thumb{width:20px;height:20px}
      #tt-auto-boss-panel.cp .ab-ticks{height:22px}
      #tt-auto-boss-panel.cp #ab-log{display:none!important}
      #tt-auto-boss-panel.cp.logopen #ab-log{display:block!important;position:absolute;left:0;right:0;top:48px;bottom:0;height:auto;z-index:7;padding:10px 12px}

      #tt-auto-boss-panel .ab-brand small#ab-req{margin-left:2px}
      #tt-auto-boss-panel.cp .ab-brand small#ab-req{display:none}
      #tt-auto-boss-panel #ab-strip-req{color:var(--mute);font-variant-numeric:tabular-nums}
      #tt-auto-boss-panel .ab-hs{padding:8px 10px;background:var(--ink2);border-radius:8px}
      #tt-auto-boss-panel .ab-hstext{color:var(--mute);font-size:var(--fs-s);line-height:1.45;margin-bottom:2px}
      #tt-auto-boss-panel .ab-subhd{margin-top:14px;color:var(--paper)}
      #tt-auto-boss-panel .ab-range.single .ab-fill{left:0}
      @media (prefers-reduced-motion:reduce){#tt-auto-boss-panel *{animation:none!important;transition:none!important}}
    </style>
    <div id="ab-drag" title="Kéo để di chuyển bảng, nhấp đúp để về góc phải dưới">
      <span class="ab-brand">
        <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true"><rect width="20" height="20" rx="4" fill="#ec5f45"/><circle cx="10" cy="10" r="6.6" fill="#f3ebe0"/><path d="M10 3.4a6.6 6.6 0 0 1 0 13.2 3.3 3.3 0 0 1 0-6.6 3.3 3.3 0 0 0 0-6.6z" fill="#131a1d"/><circle cx="10" cy="6.7" r="1" fill="#f3ebe0"/><circle cx="10" cy="13.3" r="1" fill="#131a1d"/></svg>
        <b>Tu Tiên</b><small>v${VERSION}</small><small id="ab-req" title="Số lệnh tool đã gửi tới game trong 60 giây gần nhất và số lệnh đang chờ. Hai lệnh liên tiếp cách nhau tối thiểu ~1 giây, lệnh dồn thì tự xếp hàng."></small>
      </span>
      <span class="ab-tbs"><button id="ab-ui" class="ab-tb" title="Đổi giao diện: máy tính / màn hình nhỏ (cảm ứng)">▭</button><button id="ab-min-ctrl" class="ab-tb" title="Thu nhỏ / mở rộng phần điều khiển (giữ nguyên log)">🎛</button><button id="ab-min-log" class="ab-tb" title="Thu nhỏ / mở rộng phần log (giữ nguyên điều khiển)">📜</button><button id="ab-min" class="ab-tb" title="Thu nhỏ / mở rộng cả bảng">−</button></span>
    </div>
    <div id="ab-rail">
      <button type="button" id="ab-rail-open" class="ab-rb" aria-label="Mở rộng bảng">«</button>
      ${[['boss','Boss'],['um','U Minh'],['hunt','Săn'],['tower','Tháp'],['farm','Tầm bảo'],['xh','Hồn']].map(([k, n]) => `<button type="button" class="ab-rb" data-rk="${k}" data-on="0" aria-label="${n}"><i></i><span>${n}</span></button>`).join('')}
      <div id="ab-rail-n" aria-live="polite">0</div>
    </div>
    <div id="ab-body">
    <div id="ab-strip"><div class="ab-srow"><span id="ab-strip-run" data-n="0"></span><span id="ab-strip-tix"></span></div><div class="ab-srow"><span id="ab-strip-req"></span></div><button type="button" id="ab-strip-log" title="Chạm để xem toàn bộ log"></button></div>
    <div id="ab-ctrl">
      <div class="ab-tabs" role="tablist">
        <button class="ab-tab" role="tab" data-tab="fight" aria-selected="true">Chiến đấu</button>
        <button class="ab-tab" role="tab" data-tab="grow" aria-selected="false">Tu luyện</button>
        <button class="ab-tab" role="tab" data-tab="kit" aria-selected="false">Hành trang</button>
        <button class="ab-tab" role="tab" data-tab="acct" aria-selected="false">Tài khoản</button>
      </div>

      <div class="ab-pane on" data-pane="fight">
        <p class="ab-note">Ưu tiên từ trên xuống. Đột phá luôn đầu; 3 phút đầu mỗi giờ dành cho boss.</p>
        <div class="ab-ladder">
        ${row('boss', 1, 'Boss', `
          <div class="ab-chips">
            <label class="ab-chip"><input type="checkbox" data-sz="small" checked> Nhỏ</label>
            <label class="ab-chip"><input type="checkbox" data-sz="medium" checked> Trung</label>
            <label class="ab-chip"><input type="checkbox" data-sz="large" checked> Đại</label>
          </div>
          <div class="ab-chips" title="Chế độ riêng cho từng cỡ boss. Tới cùng: đánh tới khi boss chết. ≥70%: chỉ đánh khi boss còn ≥ 70% HP, xuống dưới 70% là dừng. 50% / 25% + last hit: khi sát thương của bạn đạt 50% / 25% HP tối đa thì tạm dừng, chờ boss còn ≤ 2.5% HP rồi đánh tiếp để giành last hit (chờ tối đa 30 phút).">
            ${['small', 'medium', 'large'].map(z => `<select class="ab-sel" data-bm="${z}" style="flex:1;min-width:0"><option value="full">Tới cùng</option><option value="min70">Chỉ khi ≥70%</option><option value="dmg50">Dừng 50% · last hit</option><option value="dmg25">Dừng 25% · last hit</option></select>`).join('')}
          </div>
          <button id="ab-toggle" class="ab-act">▶ Bật boss</button>
<details class="ab-more"><summary>Ngưỡng HP / MP · hồi máu</summary>
          ${hp('boss')}
          ${mp('boss')}
          ${hs('boss')}
          </details>`)}
        ${row('um', 2, 'U Minh Cốc', `
          <select id="ab-um-gate" title="Cổng vào. Tự chọn: bỏ cổng bị chặn (và cổng vừa gục nếu còn cổng khác), chọn cổng có nhiều ô chưa mở nhất xung quanh, rồi tới vùng bán kính 3 ô.">
            <option value="auto">Tự chọn cổng</option><option value="top">Cổng Bắc</option><option value="bottom">Cổng Nam</option><option value="right">Cổng Đông</option><option value="left">Cổng Tây</option>
          </select>
          <button id="ab-um-toggle" class="ab-act" title="Khi bật: tự vào U Minh Cốc đầu mỗi giờ, tránh ô độc vụ / núi đá đã biết, đi về phía ô chưa mở, gặp quái thì đánh.">▶ Bật U Minh Cốc</button>
          <div id="ab-um-status" class="ab-status"></div>
          <div class="ab-status">Mở đầu mỗi giờ, kéo dài 30 phút.</div>
<details class="ab-more"><summary>Ngưỡng HP / MP · hồi máu</summary>
          ${hp('um')}
          ${mp('um')}
          ${gt('um')}
          ${hs('um')}
          </details>`)}
        ${row('hunt', 3, 'Săn yêu', `
          <div class="ab-line">
            <select id="ab-monster" title="[số] = required_realm (cảnh giới tối thiểu). Xếp theo số đó, cùng số xếp theo id. 🔒 = chưa đủ cảnh giới"><option>Đang tải danh sách yêu…</option></select>
            <button id="ab-monster-refresh" class="ab-mini" title="Tải lại danh sách yêu / cảnh giới">↻</button>
          </div>
          <button id="ab-hunt-toggle" class="ab-act">▶ Bật săn yêu</button>
          <div id="ab-tickets" class="ab-status"></div>
<details class="ab-more"><summary>Ngưỡng HP / MP · hồi máu</summary>
          ${hp('hunt')}
          ${mp('hunt')}
          ${gt('hunt')}
          ${hs('hunt')}
          </details>`)}
        ${row('tower', 4, 'Leo tháp', `
          <button id="ab-tower-toggle" class="ab-act" title="Khi bật: tự leo tháp, đánh giống săn yêu / tầm bảo. Ưu tiên dưới boss, U Minh Cốc, săn yêu; trên tầm bảo (tầm bảo tạm nhường khi leo tháp đang bật).">▶ Bật leo tháp</button>
          <div id="ab-tower-status" class="ab-status"></div>
          <div class="ab-status">Đánh từng tầng; thua 5 lần liên tiếp thì tự dừng.</div>
<details class="ab-more"><summary>Ngưỡng HP / MP · hồi máu</summary>
          ${hp('tower')}
          ${mp('tower')}
          ${gt('tower')}
          ${hs('tower')}
          </details>`)}
        ${row('farm', 5, 'Tầm bảo', `
          <select id="ab-zone"></select>
          <button id="ab-farm-toggle" class="ab-act">▶ Bật tầm bảo</button>
          <div id="ab-farm-tickets" class="ab-status"></div>
<details class="ab-more"><summary>Ngưỡng HP / MP · hồi máu</summary>
          ${hp('farm')}
          ${mp('farm')}
          ${gt('farm')}
          ${hs('farm')}
          </details>`)}
        ${row('xh', 6, 'Xuất hồn', `
          <label class="ab-field">Bản đồ<select id="ab-xh-map" title="Mặc định: bản đồ cao nhất đã mở khóa (tự đổi khi bạn lên cảnh giới). Chọn bản đồ cụ thể thì giữ bản đồ đó."><option value="auto">Cao nhất có thể</option></select></label>
          <label class="ab-field">Thời gian<select id="ab-xh-dur" title="Thời gian mỗi lượt xuất hồn"><option value="5">5 phút</option><option value="10">10 phút</option><option value="20">20 phút</option><option value="60">60 phút</option></select></label>
          <button id="ab-xh-toggle" class="ab-act" title="Chỉ chạy khi U Minh Cốc đã đi xong (hoặc tắt) và tầm bảo hết vé (hoặc tắt). Không ảnh hưởng boss, săn yêu, leo tháp.">▶ Bật xuất hồn</button>
          <div id="ab-xh-info" class="ab-status"></div>
          <div id="ab-xh-status" class="ab-status"></div>
          <div class="ab-status">Chạy khi U Minh Cốc đã đi xong (hoặc tắt) và tầm bảo hết vé (hoặc tắt). Còn ít hơn 5 phút tới đầu giờ (hoặc ít hơn mức thời gian đã chọn, nếu dài hơn 5 phút) thì không bắt đầu lượt mới.</div>`)}
        </div>
      </div>

      <div class="ab-pane" data-pane="grow">
        <div class="ab-ladder">
        ${row('bt', '', 'Đột phá', `
          <label class="ab-chk" title="Khi tu vi đủ (exp ≥ exp_to_next) thì tự đột phá. Thất bại sẽ mất một phần tu vi. Không tự đột phá nếu sẽ gây thiên kiếp."><input type="checkbox" id="ab-bt-on"> Tự động đột phá khi đủ tu vi</label>
          <label class="ab-chk" title="Khi tỉ lệ đột phá còn dưới 100%: dùng 1 viên đan tăng tỉ lệ đã chọn (nếu chưa có buff đan này). Công pháp tăng đột phá mạnh nhất luôn được tự đổi sang khi tỉ lệ dưới 100%, đột phá xong tự đổi lại."><input type="checkbox" id="ab-bt-pill-on"> Dùng đan tăng tỉ lệ đột phá</label>
          <div class="ab-line"><select id="ab-bt-pill" title="Đan có hiệu ứng tăng tỉ lệ đột phá trong túi (kèm số lượng)"><option>Đang tải…</option></select>
            <button id="ab-bt-pill-refresh" class="ab-mini" title="Tải lại túi đồ">↻</button></div>
          <div class="ab-status">Ưu tiên cao nhất: các chế độ khác chờ trận dở xong rồi nhường.</div>`)}
        ${row('alchemy', '', 'Luyện đan', `
          <div class="ab-line">
            <select id="ab-alchemy-recipe" title="Loại đan cần giữ luôn có trong túi. Chỉ hiện đan phương đã học và chưa bị khóa."><option>Đang tải danh sách đan…</option></select>
            <button id="ab-alchemy-refresh" class="ab-mini" title="Tải lại danh sách đan phương">↻</button>
          </div>
          <label class="ab-chk" title="Riêng cho loại đan đang chọn ở trên: nguyên liệu đủ 50 lượt thì luyện 50 lượt ngay, kể cả khi trong túi còn đan."><input type="checkbox" id="ab-bulk-main"> Luyện ngay khi đủ nguyên liệu cho 50 lượt</label>
          <div id="ab-bulk-list"></div>
          <button id="ab-bulk-add" type="button" class="ab-mini" title="Thêm một loại đan khác để tự luyện khi đủ nguyên liệu cho 50 lượt">＋ Thêm loại đan</button>
          <button id="ab-alchemy-toggle" class="ab-act" title="Công tắc tổng. Khi bật: số đan = 0 thì luyện; còn đan thì cứ 5 phút kiểm tra lại. Các loại bật ô \"đủ 50 lượt\" được luyện ngay khi đủ nguyên liệu.">▶ Bật luyện đan</button>
          <div class="ab-status">Hết đan mới luyện, tối đa 50 lượt mỗi lần. Ô "đủ 50 lượt" tính riêng từng loại; luyện liên tiếp cách nhau 3 giây.</div>`)}
        ${row('garden', '', 'Linh điền', `
          <div class="ab-line">
            <select id="ab-garden-seed" title="Hạt giống sẽ trồng lại sau mỗi lần thu hoạch. Chỉ hiện hạt chưa bị khóa cảnh giới."><option>Đang tải hạt giống…</option></select>
            <button id="ab-garden-refresh" class="ab-mini" title="Tải lại danh sách hạt giống">↻</button>
          </div>
          <button id="ab-garden-toggle" class="ab-act" title="Công tắc chính: chỉ khi bật thì 2 nút Thu hoạch / Trồng thêm bên dưới mới hoạt động.">▶ Bật Linh Điền</button>
          <div class="ab-subs">
            <button id="ab-garden-harvest" class="ab-sub" data-on="1" data-live="0" title="BẬT: xem có ô chín không, ô chưa chín còn bao lâu; tới giờ thì thu hoạch (chờ ô sớm nhất + 60s).">🌾 Thu hoạch: BẬT</button>
            <button id="ab-garden-plant" class="ab-sub" data-on="1" data-live="0" title="BẬT: trồng hạt đang chọn ở droplist vào các ô trống (có kiểm tra linh thạch).">🌱 Trồng thêm: BẬT</button>
          </div>
          <div id="ab-garden-stones" class="ab-status"></div>
          <div id="ab-garden-status" class="ab-status"></div>`)}
        ${row('beast', '', 'Yêu thú', `
          <div id="ab-beast-info" class="ab-status"></div>
          <div class="ab-status">Phóng sinh các loại được tích (không hoàn lại được):</div>
          <div class="ab-chips" id="ab-beast-rar">
            <label class="ab-chip"><input type="checkbox" data-rar="thuong"> Thường</label>
            <label class="ab-chip"><input type="checkbox" data-rar="hiem"> Hiếm</label>
            <label class="ab-chip"><input type="checkbox" data-rar="su_thi"> Sử thi</label>
            <label class="ab-chip"><input type="checkbox" data-rar="huyen_thoai"> Huyền thoại</label>
          </div>
          <div id="ab-beast-warn" class="ab-status" style="display:none;color:var(--gold)">⚠ Sử thi / Huyền thoại: chế độ TỰ ĐỘNG không bao giờ phóng sinh hai loại này. Chỉ nút "Phóng sinh ngay" làm được, sau khi bạn xác nhận.</div>
          <label class="ab-field">Giữ lại (không phóng sinh)
            <select id="ab-beast-keep" title="Thú từ số sao này trở lên luôn được giữ lại.">
              <option value="0">Không giữ</option><option value="1">Giữ lại từ 1★ trở lên</option><option value="2">Giữ lại từ 2★ trở lên</option><option value="3">Giữ lại từ 3★ trở lên</option><option value="4">Giữ lại từ 4★ trở lên</option><option value="5">Giữ lại từ 5★ trở lên</option>
            </select></label>
          <div class="ab-status">Luôn bỏ qua: thú đang xuất chiến và thú đã lên cấp (level &gt; 1).</div>
          <div class="ab-line">
            <button id="ab-beast-hatch" type="button" class="ab-act" style="flex:1" title="Mở hết Thú Đản đang có (mỗi lệnh tối đa 15, Yêu Thú Các tối đa 20 con).">🥚 Mở trứng</button>
            <button id="ab-beast-release" type="button" class="ab-act" style="flex:1" title="Phóng sinh ngay các con khớp bộ lọc. Có hộp xác nhận nếu gồm Sử thi / Huyền thoại.">🕊 Phóng sinh ngay</button>
          </div>
          <button id="ab-beast-toggle" class="ab-act" title="Tự động: phóng sinh (Thường / Hiếm theo bộ lọc) để có chỗ, rồi mở trứng; kiểm tra lại mỗi 60 phút.">▶ Bật tự động yêu thú</button>
          <div id="ab-beast-status" class="ab-status"></div>`)}
        ${row('war', '', 'Tông Chiến', `
          <label class="ab-field">Lãnh địa<select id="ab-war-terr" title="Chỉ hiện lãnh địa tông bạn đã đăng ký. Tự chọn: vòng cao hơn trước, bằng nhau thì cái đứng trước trong danh sách. Bạn chọn tay thì giữ tới 20:55, sau đó về tự chọn. Quét lại khi bật và mỗi giờ lúc xx:25. Đã vào lãnh địa trong ngày thì không đổi được tới hôm sau."><option value="auto">Tự chọn (vòng cao trước)</option></select></label>
          <button id="ab-war-toggle" class="ab-act" title="Bật cả ngày, chỉ hành động trong khung giờ sự kiện. Đổi chiêu rồi vào lãnh địa trước giờ đánh (server chụp bộ chiêu lúc vào). Đánh người chơi khác tông (power tối đa 12000) trước, hết thì đánh thủ vệ (tối đa 5 lần thắng), hết nữa thì chờ người chơi xuất hiện. Dừng khi hết giờ hoặc đủ lượt tối đa của server.">▶ Bật Tông Chiến</button>
          <div id="ab-war-info" class="ab-status"></div>
          <div id="ab-war-status" class="ab-status"></div>
          <div class="ab-status">Chỉ đánh trong khung giờ sự kiện (20:30 – 20:50). Đổi chiêu phải xong trước khi vào lãnh địa, nên tool đổi chiêu lúc tập hợp.</div>`)}
        </div>
      </div>

      <div class="ab-pane" data-pane="kit">
        ${sect('Võ kỹ', 'tối đa 3 chiêu; đổi chiêu có hiệu lực từ trận sau', `
          <div class="ab-line"><label class="ab-chk" style="flex:1" title="Trước mỗi trận boss: nếu bộ chiêu đang mang đã có chiêu công kích khắc hệ boss thì giữ nguyên. Nếu chưa, tìm trong các chiêu dự bị (ô &quot;Chiêu dùng để thay&quot;) chiêu khắc mạnh nhất và đổi tối thiểu (còn ô trống thì chỉ gắn thêm; hết ô thì tháo 1 chiêu công kích yếu nhất không khắc). Không có chiêu dự bị khắc thì giữ nguyên."><input type="checkbox" id="ab-autoswap" checked> Tự đổi chiêu khắc hệ (chỉ trước boss)</label>
            <button id="ab-skills-refresh" class="ab-mini" title="Tải lại danh sách chiêu">↻</button></div>
          <div id="ab-swap-pool">
            <div class="ab-status" style="margin-bottom:6px" title="Chiêu dự bị: chỉ khi bộ chiêu đang mang không có chiêu khắc hệ boss, tool mới tìm trong các chiêu chọn ở đây. Để trống cả 3 ô = không tìm, giữ nguyên bộ chiêu.">Chiêu dùng để thay (3 ô; trống hết = không đổi):</div>
            <div id="ab-swap-pool-list"></div>
          </div>
          <div id="ab-skills"></div>
          <div id="ab-skill-pending" class="ab-status"></div>`)}
        ${sect('Đan', 'chọn loại đan, hồi ngay', `
          <div class="ab-line"><span class="ab-lbl">HP</span><select id="ab-pillbook-hp" title="Đan hồi HP dùng khi bật 'Dùng đan hồi HP' ở các chế độ"><option>Đang tải…</option></select></div>
          <div class="ab-line"><span class="ab-lbl">MP</span><select id="ab-pillbook-mp" title="Đan hồi MP dùng cho 'Dùng đan hồi MP' và nút 'Hồi MP ngay'"><option>Đang tải…</option></select>
            <button id="ab-pillbook-refresh" class="ab-mini" title="Tải lại túi đồ / tồn kho đan">↻</button></div>
          <div class="ab-subhd">Hồi ngay</div>
          <div class="ab-status">Kéo thanh tới mức mong muốn (<span class="ab-n" id="ab-hpnow-t">50</span>%) rồi bấm: Hồi MP ngay dùng đan hồi MP tới mức đó, Hồi HP ngay dùng đan hồi HP tới mức đó.</div>
          <div>
            <div class="ab-range single" title="Mức cần hồi tới khi bấm Hồi MP ngay hoặc Hồi HP ngay: 5% – 95%, mỗi nấc 5%.">
              <div class="ab-track"><div class="ab-fill"></div></div>
              <input type="range" class="ab-hi" id="ab-hpnow" min="5" max="95" step="5" value="50">
            </div>
            <div class="ab-ticks"></div>
          </div>
          <div class="ab-line">
            <button id="ab-pill-now" class="ab-act" style="flex:1" title="Dùng đan hồi MP đã chọn ở mục Đan ngay cho tới mức ở thanh trượt phía trên. Không cần đang có trận chiến.">🧪 Hồi MP ngay</button>
            <button id="ab-hp-now" class="ab-act" style="flex:1" title="Dùng đan hồi HP đã chọn ở mục Đan ngay cho tới mức ở thanh trượt phía trên. Không cần đang có trận chiến.">🧪 Hồi HP ngay</button>
          </div>`)}
        ${sect('Mở nhiều', 'rương và vật phẩm mở được, mỗi lượt tối đa 300', `
          <div class="ab-line"><select id="ab-chest-item" title="Vật phẩm cần mở nhiều (kèm số lượng đang có)"><option>Đang tải…</option></select>
            <button id="ab-chest-refresh" class="ab-mini" title="Tải lại túi đồ">↻</button></div>
          <button id="ab-chest-open" type="button" class="ab-act" title="Mở hết vật phẩm đang chọn, mỗi lượt tối đa 300 cái. Bấm lần nữa để dừng sau lượt hiện tại.">Mở nhiều (≤300)</button>
          <div id="ab-chest-status" class="ab-status"></div>`)}
        ${sect('Bán đồ', 'bán một loại vật phẩm trong túi, không hoàn tác', `
          <div class="ab-line"><select id="ab-sell-item" title="Vật phẩm bán được (không đang trang bị, không cường hóa, không khóa bán)"><option>Đang tải…</option></select>
            <button id="ab-sell-refresh" class="ab-mini" title="Tải lại túi đồ">↻</button></div>
          <div class="ab-line"><input type="number" id="ab-sell-qty" min="1" step="1" value="1" title="Số lượng cần bán (mặc định 1, tối đa bằng số đang có)"></div>
          <div id="ab-sell-preview" class="ab-status"></div>
          <button id="ab-sell-go" type="button" class="ab-act" title="Bán vật phẩm đang chọn theo số lượng. Có hộp xác nhận. Bấm lần nữa khi đang chạy để dừng.">Bán</button>
          <div id="ab-sell-status" class="ab-status"></div>`)}
      </div>

      <div class="ab-pane" data-pane="acct">
        ${sect('Tự chạy lại', 'sau khi đăng nhập / tải lại trang', `
          <label class="ab-chk" title="Tool nhớ chế độ nào bạn đang bật. Khi game cập nhật / bị thoát và đăng nhập lại, tool tự bật lại đúng các chế độ đó."><input type="checkbox" id="ab-resume" checked> Tự bật lại các chế độ đã bật sau khi đăng nhập</label>
          <div id="ab-resume-info" class="ab-status"></div>`)}
        ${sect('Tự đăng nhập', 'khi game hiện màn hình đăng nhập', `
          <label class="ab-field">Tên đăng nhập<input id="ab-login-user" class="ab-in" type="text" autocomplete="off" spellcheck="false" autocapitalize="off"></label>
          <label class="ab-field">Mật khẩu<span class="ab-line"><input id="ab-login-pass" class="ab-in" type="password" autocomplete="new-password" spellcheck="false"><button id="ab-login-show" type="button" class="ab-mini" title="Hiện / ẩn mật khẩu">Hiện</button></span></label>
          <label class="ab-chk" title="Khi bật: thấy màn hình đăng nhập (kể cả lúc phiên hết hạn) thì tự điền và bấm Đăng Nhập."><input type="checkbox" id="ab-login-on"> Tự đăng nhập khi thấy màn hình đăng nhập</label>
          <div id="ab-login-status" class="ab-status"></div>
          <div class="ab-status">Tool chỉ điền form và bấm nút Đăng Nhập của game. Cloudflare vẫn do trang tự xác minh trong trình duyệt của bạn; nếu nó hiện ô cần tick thì bạn tick, tool sẽ bấm tiếp.</div>
          <div class="ab-status" style="color:var(--gold)">Tên và mật khẩu lưu trong trình duyệt này dưới dạng chữ thường (không mã hóa). Chỉ dùng trên máy của bạn.</div>`)}
      </div>
    </div>
    <div id="ab-log"></div>
    </div>`;
      return panel;
    }

    /* ----- khởi tạo: gọi SAU khi controller đã đăng ký listener ----- */
    init() {
      // Gắn vào <html> và tự gắn lại nếu game vẽ lại trang làm mất bảng
      const mount = () => { if (!this.panel.isConnected) (document.body || document.documentElement).appendChild(this.panel); };
      mount();
      setInterval(mount, 3000);
      console.log(`[Auto Boss] đã tải script v${VERSION}, bảng điều khiển ở góc phải dưới.`);

      this.initZones();
      this.bindControls();
      this.initRows();
      this.initTabs();
      this.initDrag();
      this.initMinimize();
      this.initLayout();
    }

    isCp() { return this.panel.classList.contains('cp'); }

    /* ----- thang ưu tiên: mở / gập từng dòng, công tắc nhanh ----- */
    initRows() {
      const OPEN_KEY = 'tt-auto-boss-open';
      const { panel, storage } = this;
      const open = storage.getJSON(OPEN_KEY, null) || {};
      const TARGET = { boss: '#ab-toggle', um: '#ab-um-toggle', hunt: '#ab-hunt-toggle', tower: '#ab-tower-toggle', farm: '#ab-farm-toggle', xh: '#ab-xh-toggle', alchemy: '#ab-alchemy-toggle', garden: '#ab-garden-toggle', beast: '#ab-beast-toggle', war: '#ab-war-toggle', bt: '#ab-bt-on' };
      // giao diện máy tính: mở / gập tại chỗ và nhớ lại; giao diện nhỏ: mở thành trang riêng, không nhớ
      const fold = (row, on, save) => {
        row.dataset.open = on ? '1' : '0';
        const head = row.querySelector('.ab-head'); if (head) head.setAttribute('aria-expanded', on ? 'true' : 'false');
        if (save && !this.isCp()) { open[row.dataset.key] = on ? 1 : 0; storage.setJSON(OPEN_KEY, open); }
      };
      this.refold = () => panel.querySelectorAll('.ab-row,.ab-sect').forEach(r => fold(r, !this.isCp() && r.classList.contains('ab-row') && !!open[r.dataset.key], false));
      panel.querySelectorAll('.ab-row').forEach(row => {
        const key = row.dataset.key, head = row.querySelector('.ab-head'), sw = row.querySelector('.ab-sw');
        fold(row, !!open[key], false);
        head.addEventListener('click', () => fold(row, row.dataset.open !== '1', true));
        head.addEventListener('keydown', e => { if (e.target === head && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); head.click(); } });
        const press = e => { e.stopPropagation(); const t = panel.querySelector(TARGET[key]); if (t) t.click(); };
        sw.addEventListener('click', press);
        sw.addEventListener('pointerdown', e => e.stopPropagation());
        sw.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); press(e); } });
        this.sumRender(key);
      });
      // nhóm thường (Hành trang, Tài khoản): chỉ gập được ở giao diện nhỏ
      panel.querySelectorAll('.ab-sect').forEach(sec => {
        const h = sec.querySelector('h3');
        const go = () => { if (this.isCp()) fold(sec, true, false); };
        h.addEventListener('click', go);
        h.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
      });
      panel.querySelectorAll('.ab-back').forEach(b => b.addEventListener('click', () => { const host = b.closest('.ab-row,.ab-sect'); if (host) fold(host, false, false); }));
      this.syncBt();
    }
    initTabs() {
      const TAB_KEY = 'tt-auto-boss-tab';
      const { panel, storage } = this;
      const tabs = [...panel.querySelectorAll('.ab-tab')];
      const pick = (name, save) => {
        for (const t of tabs) t.setAttribute('aria-selected', t.dataset.tab === name ? 'true' : 'false');
        panel.querySelectorAll('.ab-pane').forEach(p => p.classList.toggle('on', p.dataset.pane === name));
        if (save) storage.setRaw(TAB_KEY, name);
        this.emit('tab', name);
        if (this.place && panel.style.left) { const r = panel.getBoundingClientRect(); this.place(r.left, r.top); }
      };
      tabs.forEach(t => t.addEventListener('click', () => pick(t.dataset.tab, true)));
      const sv = storage.getRaw(TAB_KEY);
      pick(tabs.some(t => t.dataset.tab === sv) ? sv : 'fight', false);
    }
    // dòng trạng thái ngắn dưới tên chế độ
    sumRender(key) {
      const el = this.panel.querySelector(`[data-sum="${key}"]`); if (!el) return;
      const on = !!this.live[key];
      el.textContent = this.sumText[key] || (on ? (key === 'bt' ? 'Đang canh tu vi' : 'Đang chạy') : 'Đã tắt'); el.title = el.textContent;
    }
    setSum(key, text) { this.sumText[key] = text || ''; this.sumRender(key); }
    markRow(key, on) {
      this.live[key] = !!on;
      const row = this.panel.querySelector(`.ab-row[data-key="${key}"]`); if (!row) return;
      row.dataset.on = on ? '1' : '0';
      const sw = row.querySelector('.ab-sw'); if (sw) sw.setAttribute('aria-checked', on ? 'true' : 'false');
      this.sumRender(key);
      this.renderStrip();
    }
    // dải trạng thái + thanh thu gọn của giao diện nhỏ
    renderStrip() {
      if (!this.$stripRun) return;
      const NAMES = { boss: 'Boss', um: 'U Minh', hunt: 'Săn yêu', tower: 'Leo tháp', farm: 'Tầm bảo', xh: 'Xuất hồn', bt: 'Đột phá', alchemy: 'Luyện đan', garden: 'Linh điền', beast: 'Yêu thú', war: 'Tông Chiến' };
      const run = Object.keys(NAMES).filter(k => this.live[k]);
      this.$stripRun.dataset.n = String(run.length);
      this.$stripRun.textContent = run.length ? '' : 'Chưa bật chế độ nào';
      for (const k of run) { // mỗi chế độ đang chạy là 1 nút: chạm để tắt, không phải đổi tab
        const b = document.createElement('button'); b.type = 'button'; b.className = 'ab-run'; b.dataset.stop = k; b.title = `Chạm để tắt ${NAMES[k]}`; b.textContent = `${NAMES[k]} ✕`;
        this.$stripRun.appendChild(b);
      }
      this.$stripTix.textContent = [this.tix.hunt, this.tix.farm].filter(Boolean).join(' · ');
      this.$railN.textContent = String(run.length);
      this.panel.querySelectorAll('.ab-rb[data-rk]').forEach(b => { b.dataset.on = this.live[b.dataset.rk] ? '1' : '0'; });
    }
    syncBt() { this.markRow('bt', this.$btOn.checked); }

    initZones() {
      ZONES.forEach(([code, name], i) => {
        const o = document.createElement('option');
        o.value = code; o.textContent = `${i + 1}. Bí Cảnh ${name}`;
        this.$zone.appendChild(o);
      });
      // map đã lưu (đổi trong droplist) được khôi phục ở đây, vì lúc App đọc localStorage thì droplist chưa có mục nào; không hợp lệ thì dùng mặc định
      const saved = this.storage.getRaw('tt-auto-boss-farm-zone');
      this.$zone.value = ZONES.some(z => z[0] === saved) ? saved : DEFAULT_ZONE;
    }

    bindControls() {
      this.panel.querySelectorAll('[data-sz]').forEach(c => c.addEventListener('change', () => this.emit('boss:size', c.dataset.sz, c.checked)));
      this.panel.querySelectorAll('[data-bm]').forEach(c => c.addEventListener('change', () => this.emit('boss:mode', c.dataset.bm, c.value)));
      this.$boss.addEventListener('click', () => this.emit('boss:toggle'));
      this.$farm.addEventListener('click', () => this.emit('farm:toggle'));
      this.$hunt.addEventListener('click', () => this.emit('hunt:toggle'));
      this.$zone.addEventListener('change', () => this.emit('farm:zone', this.$zone.value));
      this.$monster.addEventListener('change', () => this.emit('hunt:monster', Number(this.$monster.value) || null));
      this.panel.querySelector('#ab-monster-refresh').addEventListener('click', () => this.emit('hunt:refresh'));
      this.$btOn.addEventListener('change', () => { this.syncBt(); this.emit('bt:toggle', this.$btOn.checked); });
      this.$btPillOn.addEventListener('change', () => this.emit('bt:pillon', this.$btPillOn.checked));
      this.$btPill.addEventListener('change', () => this.emit('bt:pill', this.$btPill.value === '' || !this.btPillKeys ? null : this.btPillKeys[Number(this.$btPill.value)]));
      this.panel.querySelector('#ab-bt-pill-refresh').addEventListener('click', () => this.emit('bt:pillrefresh'));
      this.$alchemy.addEventListener('click', () => this.emit('alchemy:toggle'));
      this.$garden.addEventListener('click', () => this.emit('garden:toggle'));
      this.$seed.addEventListener('change', () => this.emit('garden:seed', Number(this.$seed.value) || null));
      this.panel.querySelector('#ab-garden-refresh').addEventListener('click', () => this.emit('garden:refresh'));
      this.$gHarvest.addEventListener('click', () => this.emit('garden:harvest', !this.gOpts.harvest));
      this.$gPlant.addEventListener('click', () => this.emit('garden:plant', !this.gOpts.plant));
      for (const sp of DUAL_SPECS) for (const k of sp.modes) {
        const id = `${sp.p}-${k}`, cb = this.panel.querySelector(`#ab-${id}`), sl = this.dual[id];
        sl.on('change', (lo, hi) => { this.showDual(id); this.emit(`${sp.ev}:range`, k, lo, hi); });
        sl.init();
        cb.addEventListener('change', () => { this.showDual(id); this.emit(`${sp.ev}:toggle`, k, cb.checked); });
      }
      for (const k of MODES5) {
        const sl = this.healSliders[k];
        sl.on('change', (lo, hi) => { this.showHs(k); this.emit('heal:range', k, lo, hi); });
        sl.init();
      }
      this.hpNow.on('change', v => { this.panel.querySelector('#ab-hpnow-t').textContent = String(v); this.emit('hpnow:range', v); });
      this.hpNow.init();
      this.$hpNow.addEventListener('click', () => this.emit('hpnow:go'));
      this.$pbHp.addEventListener('change', () => this.emit('pillbook:select', 'hp', this.pbValue(this.$pbHp), this.pbName(this.$pbHp)));
      this.$pbMp.addEventListener('change', () => this.emit('pillbook:select', 'mp', this.pbValue(this.$pbMp), this.pbName(this.$pbMp)));
      this.panel.querySelector('#ab-pillbook-refresh').addEventListener('click', () => this.emit('pillbook:refresh'));
      this.$chestSel.addEventListener('change', () => this.emit('chest:select', this.$chestSel.value === '' ? null : this.chestKey(this.$chestSel.value)));
      this.panel.querySelector('#ab-chest-refresh').addEventListener('click', () => this.emit('chest:refresh'));
      this.$chestOpen.addEventListener('click', () => this.emit('chest:go'));
      this.$sellSel.addEventListener('change', () => this.emit('sell:select', this.sellKey()));
      this.$sellQty.addEventListener('input', () => this.emit('sell:qty', this.$sellQty.value));
      this.panel.querySelector('#ab-sell-refresh').addEventListener('click', () => this.emit('sell:refresh'));
      this.$sellGo.addEventListener('click', () => this.emit('sell:go'));
      this.panel.querySelector('#ab-skills-refresh').addEventListener('click', () => this.emit('skill:refresh'));
      this.$swap.addEventListener('change', () => { this.$swapPool.style.display = this.$swap.checked ? '' : 'none'; this.emit('swap:toggle', this.$swap.checked); });
      this.$um.addEventListener('click', () => this.emit('um:toggle'));
      const lg = () => this.emit('login:config', { enabled: this.$lOn.checked, user: this.$lUser.value, pass: this.$lPass.value });
      for (const el of [this.$lUser, this.$lPass]) el.addEventListener('input', lg);
      this.$lOn.addEventListener('change', lg);
      this.$lShow.addEventListener('click', () => { const h = this.$lPass.type === 'password'; this.$lPass.type = h ? 'text' : 'password'; this.$lShow.textContent = h ? 'Ẩn' : 'Hiện'; });
      this.$tower.addEventListener('click', () => this.emit('tower:toggle'));
      this.$xh.addEventListener('click', () => this.emit('xh:toggle'));
      this.$war.addEventListener('click', () => this.emit('war:toggle'));
      this.$warTerr.addEventListener('change', () => this.emit('war:terr', this.$warTerr.value));
      this.$xhMap.addEventListener('change', () => this.emit('xh:map', this.$xhMap.value));
      this.$xhDur.addEventListener('change', () => this.emit('xh:dur', Number(this.$xhDur.value)));
      this.$beast.addEventListener('click', () => this.emit('beast:toggle'));
      this.$beastHatch.addEventListener('click', () => this.emit('beast:hatch'));
      this.$beastRelease.addEventListener('click', () => this.emit('beast:release'));
      const bf = () => { this.showBeastWarn(); this.emit('beast:filter', this.beastFilter()); };
      this.panel.querySelectorAll('[data-rar]').forEach(c => c.addEventListener('change', bf));
      this.$beastKeep.addEventListener('change', bf);
      this.$resume.addEventListener('change', () => this.emit('resume:toggle', this.$resume.checked));
      this.$umGate.addEventListener('change', () => this.emit('um:gate', this.$umGate.value));
      this.$recipe.addEventListener('change', () => this.emit('alchemy:recipe', this.recipeValue));
      this.panel.querySelector('#ab-alchemy-refresh').addEventListener('click', () => this.emit('alchemy:refresh'));
      this.$bulkMain.addEventListener('change', () => this.emit('bulk:main', this.$bulkMain.checked));
      this.$bulkAdd.addEventListener('click', () => this.emit('bulk:add'));
      this.$pillNow.addEventListener('click', () => this.emit('pill:refill'));
    }

    /* ----- API cho controller ----- */
    get zone() { return this.$zone.value; }
    get monsterValue() { return Number(this.$monster.value); }
    setRunning(key, running) {
      const btn = ({ boss: this.$boss, farm: this.$farm, hunt: this.$hunt, alchemy: this.$alchemy, um: this.$um, tower: this.$tower, xh: this.$xh, garden: this.$garden, beast: this.$beast, war: this.$war })[key];
      btn.textContent = this.labels[key][running ? 1 : 0]; btn.dataset.on = running ? '1' : '0';
      this.markRow(key, running);
    }
    setUMinhGate(v) { if ([...this.$umGate.options].some(o => o.value === v)) this.$umGate.value = v; }
    // ô tích + thanh trượt đôi theo chế độ (id = '<tiền tố>-<chế độ>'): hiện / ẩn thanh trượt theo ô tích, cập nhật số %
    showDual(id) {
      const q = s => this.panel.querySelector(s), sl = this.dual[id];
      q(`#ab-${id}-box`).style.display = q(`#ab-${id}`).checked ? 'block' : 'none';
      q(`#ab-${id}-lo-t`).textContent = sl.loEl.value; q(`#ab-${id}-hi-t`).textContent = sl.hiEl.value;
    }
    setDual(id, enabled, lo, hi) { this.panel.querySelector(`#ab-${id}`).checked = !!enabled; this.dual[id].set(lo, hi); this.showDual(id); }
    showHs(k) {
      const q = s => this.panel.querySelector(s), sl = this.healSliders[k];
      q(`#ab-hs-${k}-lo-t`).textContent = sl.loEl.value; q(`#ab-hs-${k}-hi-t`).textContent = sl.hiEl.value;
    }
    setHealRange(k, lo, hi) { this.healSliders[k].set(lo, hi); this.showHs(k); }
    // bộ đếm lệnh gọi game (60 giây gần nhất) và số lệnh đang chờ trong hàng
    setReq(st) {
      const t = `Lệnh ${st.used}/phút${st.waiting ? ` · chờ ${st.waiting}` : ''}`;
      this.$req.textContent = t; this.$stripReq.textContent = t;
      this.$req.style.color = this.$stripReq.style.color = st.waiting >= 3 ? 'var(--gold)' : '';
    }
    setHpNowBusy(busy) { this.$hpNow.disabled = busy; this.$hpNow.textContent = busy ? '⏳ Đang hồi HP…' : '🧪 Hồi HP ngay'; }
    pbValue(sel) { const v = sel.value; return v === '' ? null : (/^-?\d+$/.test(v) ? Number(v) : v); }
    pbName(sel) { const o = sel.options[sel.selectedIndex]; return o ? o.dataset.name || '' : ''; }
    // Đổ danh sách đan (đã xếp từ ít → nhiều) vào droplist, kèm tồn kho. Đan đang chọn mà hết hàng vẫn hiện (tồn 0) để lựa chọn không bị đổi ngầm.
    setPillBook(book) {
      for (const [kind, sel, unit] of [['hp', this.$pbHp, 'HP'], ['mp', this.$pbMp, 'MP']]) {
        const list = book.list(kind), cur = book.sel[kind];
        sel.innerHTML = '';
        const add = (id, name, text, disabled) => { const o = document.createElement('option'); o.value = String(id); o.dataset.name = name; o.textContent = text; o.disabled = !!disabled; sel.appendChild(o); };
        if (!list.length && !cur) add('', '', `Không có đan hồi ${unit} trong túi`, true);
        if (cur && !list.some(x => x.itemId === cur.id)) add(cur.id, cur.name, `${cur.name} (hết, tồn 0)`, false);
        for (const x of list) add(x.itemId, x.name, `${x.name} (+${x.value} ${unit}, tồn ${x.qty})`, false);
        if (cur) sel.value = String(cur.id);
      }
    }
    // Võ kỹ: các chiêu đang trang bị (nút Tháo) + mỗi ô trống một droplist chọn chiêu (nút Thêm). realm = realm_id của nhân vật (để mờ chiêu chưa đủ cảnh giới)
    setSkillPending(text) { this.$skillPending.textContent = text || ''; }
    setSkills(inv, realm, busy, swap) {
      const lockedIds = (swap && swap.locked) || new Set();
      this.renderSwapPool(inv, realm, (swap && swap.pool) || new Set());
      const box = this.$skills; box.innerHTML = '';
      const row = () => { const r = document.createElement('div'); r.className = 'ab-skillrow'; box.appendChild(r); return r; };
      // lệnh đang chờ (đổi ngay sau trận): chiêu chờ tháo hiện mờ + nút Hủy, ô của nó tính là trống để chọn chiêu thay ngay; chiêu chờ gắn hiện nét đứt + nút Hủy
      const pend = (swap && swap.pending) || [];
      const pendOff = new Set(pend.filter(q => q.kind === 'unequip').map(q => q.id)), pendOn = pend.filter(q => q.kind === 'equip'), pendOnIds = new Set(pendOn.map(q => q.id));
      const eq = SkillCatalog.equipped(inv), free = SkillCatalog.available(inv).filter(x => !pendOnIds.has(x.id));
      const cancelBtn = id => { const b = document.createElement('button'); b.textContent = 'Hủy'; b.className = 'ab-mini'; b.dataset.act = 'cancel'; b.title = 'Hủy lệnh đang chờ'; b.addEventListener('click', () => this.emit('skill:cancel', id)); return b; };
      for (const x of eq) {
        const r = row(), t = document.createElement('div'), off = pendOff.has(x.id);
        t.className = 'ab-skill' + (off ? ' ab-skill-off' : '');
        t.textContent = SkillCatalog.label(x) + (off ? ' · chờ tháo' : ''); t.title = x.description || '';
        const b = off ? cancelBtn(x.id) : document.createElement('button');
        if (!off) { b.textContent = 'Tháo'; b.className = 'ab-mini'; b.disabled = !!busy; b.dataset.act = 'unequip'; b.addEventListener('click', () => this.emit('skill:unequip', x.id)); }
        const lk = document.createElement('button'), on = lockedIds.has(x.id); lk.dataset.act = 'lock';
        lk.textContent = on ? '🔒' : '🔓'; lk.className = 'ab-mini'; lk.dataset.on = on ? '1' : '0';
        lk.title = on ? 'Đang khóa: tool tự đổi chiêu sẽ KHÔNG tháo chiêu này. Bấm để mở khóa.' : 'Bấm để khóa: tool tự đổi chiêu sẽ không tháo chiêu này.';
        lk.addEventListener('click', () => this.emit('skill:lock', x.id));
        r.append(t, lk, b);
      }
      for (const q of pendOn) {
        const r = row(), t = document.createElement('div'); t.className = 'ab-skill ab-skill-on'; t.textContent = `${q.name} · chờ gắn`;
        r.append(t, cancelBtn(q.id));
      }
      const empty = Math.max(0, ((swap && swap.slots) || CFG.SKILL_SLOTS) - (eq.length - pendOff.size + pendOn.length));
      for (let i = 0; i < empty; i++) {
        const r = row(), sel = document.createElement('select'); sel.dataset.slot = String(i);
        if (!free.length) { const o = document.createElement('option'); o.textContent = 'Không còn chiêu nào để thêm'; o.disabled = true; sel.appendChild(o); }
        for (const x of free) {
          const o = document.createElement('option'), locked = typeof realm === 'number' && (x.required_realm || 0) > realm;
          o.value = String(x.id); o.textContent = (locked ? '🔒 ' : '') + SkillCatalog.label(x); o.title = (locked ? `Cần cảnh giới ${x.required_realm}. ` : '') + (x.description || ''); sel.appendChild(o); // chỉ đánh dấu 🔒, không khóa: để server quyết định
        }
        const firstOk = [...sel.options].find(o => !o.textContent.startsWith('🔒') && o.value && !o.disabled); if (firstOk) sel.value = firstOk.value;
        const b = document.createElement('button'); b.textContent = 'Thêm'; b.className = 'ab-mini'; b.disabled = !!busy || !free.length; b.dataset.act = 'equip';
        b.addEventListener('click', () => { const id = Number(sel.value); if (id) this.emit('skill:equip', id); });
        r.append(sel, b);
      }
    }
    // 3 ô chọn chiêu dùng để thay (chỉ chiêu công kích / hồi máu); giữ lựa chọn cũ
    renderSwapPool(inv, realm, pool) {
      const list = this.$swapPoolList; list.innerHTML = '';
      const opts = SkillCatalog.all(inv).filter(x => (x.skill_kind === 'attack' || x.skill_kind === 'heal') && x.is_equippable !== 0)
        .sort((a, b) => (a.skill_kind === b.skill_kind ? 0 : a.skill_kind === 'attack' ? -1 : 1) || SkillCatalog.byMp(a, b));
      const chosen = [...pool].filter(id => opts.some(x => x.id === id)).slice(0, 3);
      for (let i = 0; i < 3; i++) {
        const sel = document.createElement('select'); sel.dataset.pool = String(i);
        const none = document.createElement('option'); none.value = ''; none.textContent = '— Không chọn —'; sel.appendChild(none);
        for (const x of opts) {
          const o = document.createElement('option'), locked = typeof realm === 'number' && (x.required_realm || 0) > realm;
          o.value = String(x.id); o.textContent = (locked ? '🔒 ' : '') + (x.is_equipped ? '✔ ' : '') + SkillCatalog.label(x); o.title = x.description || ''; sel.appendChild(o);
        }
        if (chosen[i] != null) sel.value = String(chosen[i]);
        sel.addEventListener('change', () => this.emit('swap:pool', [...list.querySelectorAll('select')].map(e => Number(e.value)).filter(Boolean)));
        list.appendChild(sel);
      }
    }
    setSeeds(list, selectedId) {
      this.$seed.innerHTML = '';
      for (const x of list) { const o = document.createElement('option'); o.value = x.id; o.textContent = GardenCatalog.label(x); this.$seed.appendChild(o); }
      if (selectedId != null) this.$seed.value = String(selectedId);
    }
    // 2 nút con của Linh điền: sáng khi công tắc chính đang bật, mờ khi chưa bật
    setGardenOpts(harvest, plant) {
      this.gOpts = { harvest: !!harvest, plant: !!plant };
      this.$gHarvest.textContent = `🌾 Thu hoạch: ${harvest ? 'BẬT' : 'TẮT'}`; this.$gPlant.textContent = `🌱 Trồng thêm: ${plant ? 'BẬT' : 'TẮT'}`;
      for (const [b, on] of [[this.$gHarvest, harvest], [this.$gPlant, plant]]) { b.dataset.on = on ? '1' : '0'; b.dataset.live = this.gRunning ? '1' : '0'; }
    }
    setGardenRunning(r) { this.gRunning = !!r; this.setGardenOpts(this.gOpts.harvest, this.gOpts.plant); }
    setGardenStones(text, ok) { this.$gardenStones.textContent = text || ''; this.$gardenStones.style.color = ok === false ? '#ff7a66' : ok === true ? '#72d8b0' : ''; this.$gardenStones.style.fontWeight = ok === false ? '600' : ''; }
    setGardenStatus(text) { this.$gardenStatus.textContent = text || ''; this.setSum('garden', text); }
    setUMinhStatus(text) { this.$umStatus.textContent = text || ''; this.setSum('um', text); }
    beastFilter() {
      const rar = {}; this.panel.querySelectorAll('[data-rar]').forEach(c => { rar[c.dataset.rar] = c.checked; });
      return { rar, keep: Number(this.$beastKeep.value) || 0 };
    }
    showBeastWarn() { const on = this.panel.querySelector('[data-rar="su_thi"]').checked || this.panel.querySelector('[data-rar="huyen_thoai"]').checked; this.$beastWarn.style.display = on ? '' : 'none'; }
    setBeastFilter(f) { this.panel.querySelectorAll('[data-rar]').forEach(c => { c.checked = !!(f.rar && f.rar[c.dataset.rar]); }); this.$beastKeep.value = String(f.keep || 0); this.showBeastWarn(); }
    // mở nhiều: option.value là chỉ số trong danh sách (key có thể là số hoặc tên), nhớ ánh xạ ở this.chestKeys
    chestKey(v) { return this.chestKeys ? this.chestKeys[Number(v)] : null; }
    setChestItems(list, selectedKey) {
      this.chestKeys = list.map(it => BulkUseCatalog.key(it));
      this.$chestSel.innerHTML = '';
      if (!list.length) { const o = document.createElement('option'); o.value = ''; o.textContent = 'Không có vật phẩm mở được'; this.$chestSel.appendChild(o); return; }
      list.forEach((it, i) => { const o = document.createElement('option'); o.value = String(i); o.textContent = BulkUseCatalog.label(it); this.$chestSel.appendChild(o); });
      const at = this.chestKeys.indexOf(selectedKey);
      this.$chestSel.value = String(at >= 0 ? at : 0);
    }
    sellKey() { return this.$sellSel.value === '' || !this.sellKeys ? null : this.sellKeys[Number(this.$sellSel.value)]; }
    setSellItems(list, selectedKey) {
      this.sellKeys = list.map(x => x.key);
      this.$sellSel.innerHTML = '';
      if (!list.length) { const o = document.createElement('option'); o.value = ''; o.textContent = 'Không có vật phẩm bán được'; this.$sellSel.appendChild(o); return; }
      list.forEach((x, i) => { const o = document.createElement('option'); o.value = String(i); o.textContent = SellCatalog.label(x); this.$sellSel.appendChild(o); });
      const at = this.sellKeys.indexOf(selectedKey);
      this.$sellSel.value = String(at >= 0 ? at : 0);
    }
    setSellQty(n) { this.$sellQty.value = String(n); }
    setSellPreview(t) { this.$sellPreview.textContent = t || ''; }
    setSellStatus(t) { this.$sellStatus.textContent = t || ''; }
    setSellBusy(b) { this.$sellGo.textContent = b ? 'Dừng' : 'Bán'; this.$sellSel.disabled = !!b; this.$sellQty.disabled = !!b; }
    setChestBusy(b) { this.$chestOpen.textContent = b ? 'Dừng' : 'Mở nhiều (≤300)'; this.$chestSel.disabled = !!b; }
    setChestStatus(text) { this.$chestStatus.textContent = text || ''; }
    setBeastInfo(text) { this.$beastInfo.textContent = text || ''; this.setSum('beast', this.live.beast ? text : ''); }
    setBeastStatus(text) { this.$beastStatus.textContent = text || ''; }
    setBeastBusy(b) { this.$beastHatch.disabled = !!b; this.$beastRelease.disabled = !!b; }
    confirm(msg) { try { return !!window.confirm(msg); } catch (_) { return false; } }
    setResume(on) { this.$resume.checked = !!on; }
    setResumeInfo(text) { this.$resumeInfo.textContent = text || ''; }
    setBossModes(modes) { this.panel.querySelectorAll('[data-bm]').forEach(c => { if (modes[c.dataset.bm]) c.value = modes[c.dataset.bm]; }); }
    setBossOpts(sizes) { this.panel.querySelectorAll('[data-sz]').forEach(c => { if (c.dataset.sz in sizes) c.checked = !!sizes[c.dataset.sz]; }); }
    setZone(code) { if ([...this.$zone.options].some(o => o.value === code)) this.$zone.value = code; }
    setLogin(c) { this.$lUser.value = c.user || ''; this.$lPass.value = c.pass || ''; this.$lOn.checked = !!c.enabled; }
    setLoginStatus(text, kind) { this.$lStatus.textContent = text || ''; if (kind) this.$lStatus.dataset.kind = kind; else delete this.$lStatus.dataset.kind; }
    setAutoSwap(on) { this.$swap.checked = !!on; this.$swapPool.style.display = on ? '' : 'none'; }
    // xuất hồn: droplist bản đồ (mục đầu = tự chọn cao nhất có thể) + thời gian + dòng thông tin / trạng thái
    setXhMaps(maps, sel, durations, dur) {
      const best = XuatHonCatalog.best(maps), box = this.$xhMap; box.innerHTML = '';
      const add = (v, t, disabled) => { const o = document.createElement('option'); o.value = v; o.textContent = t; o.disabled = !!disabled; box.appendChild(o); };
      add('auto', `Cao nhất có thể${best ? ` (hiện tại: ${best.name})` : ''}`);
      (maps || []).forEach((m, i) => add(m.code, `${i + 1}. ${m.name}${m.locked ? ' (chưa mở khóa)' : ''}`, m.locked));
      box.value = [...box.options].some(o => o.value === sel && !o.disabled) ? sel : 'auto';
      if (Array.isArray(durations) && durations.length) { const d = this.$xhDur; d.innerHTML = ''; for (const n of durations) { const o = document.createElement('option'); o.value = String(n); o.textContent = `${n} phút`; d.appendChild(o); } }
      if (dur != null) this.$xhDur.value = String(dur);
    }
    setXhChoice(sel, dur) { this.$xhMap.value = [...this.$xhMap.options].some(o => o.value === sel) ? sel : 'auto'; this.$xhDur.value = String(dur); }
    setXhInfo(text) { this.$xhInfo.textContent = text || ''; }
    // Danh sách lãnh địa của tông (value = code); chosen = đang là lựa chọn tay (còn hạn), ngược lại hiện "Tự chọn" kèm lãnh địa đang dùng
    setWarTerritories(list, code, chosen) {
      const sel = this.$warTerr, cur = (list || []).find(t => t.code === code);
      sel.textContent = '';
      const add = (v, t) => { const o = document.createElement('option'); o.value = v; o.textContent = t; sel.appendChild(o); };
      add('auto', `Tự chọn (vòng cao trước)${!chosen && cur ? ` → ${cur.name}` : ''}`);
      for (const t of list || []) add(t.code, `${t.name} · ${t.ringLabel || t.ring}`);
      sel.value = chosen && cur ? code : 'auto';
    }
    setWarInfo(text) { this.$warInfo.textContent = text || ''; }
    setWarStatus(text) { this.$warStatus.textContent = text || ''; this.setSum('war', text); }
    setXhStatus(text) { this.$xhStatus.textContent = text || ''; this.setSum('xh', text); }
    setTowerStatus(text) { this.$towerStatus.textContent = text || ''; this.setSum('tower', text); }
    get recipeValue() { return Number(this.$recipe.value) || null; }
    setRecipes(list, selectedId) {
      this.$recipe.innerHTML = '';
      for (const r of list) {
        const o = document.createElement('option');
        o.value = r.id; o.textContent = AlchemyCatalog.label(r);
        this.$recipe.appendChild(o);
      }
      if (selectedId != null) this.$recipe.value = String(selectedId);
      this.recipes = list;
      if (this.bulk) this.setBulk(this.bulk.extras, this.bulk.on);
    }
    // công tắc "đủ 50 lượt" của loại chính + các dòng loại thêm (droplist ẩn loại đã có, công tắc riêng, nút xóa)
    setBulk(extras, on) {
      this.bulk = { extras, on };
      const mainId = this.recipeValue;
      this.$bulkMain.checked = !!(mainId != null && on[mainId]);
      const used = id => id === mainId || extras.includes(id);
      this.$bulkList.innerHTML = '';
      for (const id of extras) {
        const row = document.createElement('div'); row.className = 'ab-skillrow'; row.dataset.bulk = String(id);
        const sel = document.createElement('select');
        for (const r of this.recipes) {
          if (r.id !== id && used(r.id)) continue;
          const o = document.createElement('option'); o.value = String(r.id); o.textContent = AlchemyCatalog.label(r); sel.appendChild(o);
        }
        sel.value = String(id);
        sel.addEventListener('change', () => this.emit('bulk:set', id, Number(sel.value)));
        const lab = document.createElement('label'); lab.className = 'ab-chk'; lab.title = 'Đủ nguyên liệu cho 50 lượt thì luyện ngay (riêng loại này)';
        const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = !!on[id];
        cb.addEventListener('change', () => this.emit('bulk:toggle', id, cb.checked));
        lab.append(cb, document.createTextNode('50'));
        const x = document.createElement('button'); x.type = 'button'; x.className = 'ab-mini'; x.textContent = '×'; x.title = 'Xóa dòng này';
        x.addEventListener('click', () => this.emit('bulk:remove', id));
        row.append(sel, lab, x); this.$bulkList.appendChild(row);
      }
      this.$bulkAdd.disabled = !this.recipes.some(r => !used(r.id));
    }
    setTickets(n) { this.tix.hunt = typeof n === 'number' ? `Vé săn ${n}/10` : ''; this.renderStrip(); this.$tickets.textContent = typeof n === 'number' ? `Vé săn: ${n}/10 (hồi 1 vé / 60 phút)` : ''; this.setSum('hunt', typeof n === 'number' ? `Vé săn ${n}/10` : ''); }
    setFarmTickets(n, max) { const m = max || '?'; this.tix.farm = typeof n === 'number' ? `Vé tầm ${n}/${m}` : ''; this.renderStrip(); this.$farmTickets.textContent = typeof n === 'number' ? (n > 0 ? `Vé tầm bảo: ${n}/${m}` : `Hết vé tầm bảo (0/${m}), chờ tới đầu giờ sau`) : ''; this.setSum('farm', typeof n === 'number' ? `Vé ${n}/${m}` : ''); }
    setBtPills(list, selectedKey) {
      this.btPillKeys = list.map(it => BreakthroughCatalog.key(it));
      this.$btPill.innerHTML = '';
      if (!list.length) { const o = document.createElement('option'); o.value = ''; o.textContent = 'Không có đan tăng đột phá'; this.$btPill.appendChild(o); return; }
      list.forEach((it, i) => { const o = document.createElement('option'); o.value = String(i); o.textContent = BreakthroughCatalog.pillLabel(it); this.$btPill.appendChild(o); });
      const at = this.btPillKeys.indexOf(selectedKey);
      this.$btPill.value = String(at >= 0 ? at : 0);
    }
    setBtPillOn(v) { this.$btPillOn.checked = !!v; }
    setBtChecked(v) { this.$btOn.checked = !!v; this.syncBt(); }
    setPillNowBusy(busy) { this.$pillNow.disabled = busy; this.$pillNow.textContent = busy ? '⏳ Đang hồi MP…' : '🧪 Hồi MP ngay'; }
    setMonsters(sorted, realm, selectedId) {
      this.$monster.innerHTML = '';
      for (const m of sorted) {
        const o = document.createElement('option');
        o.value = m.id; o.textContent = MonsterCatalog.label(m, realm); o.disabled = !MonsterCatalog.canFight(m, realm);
        this.$monster.appendChild(o);
      }
      this.$monster.value = String(selectedId);
    }
    appendLog(tag, color, m) {
      const $log = this.$log;
      const stick = $log.scrollTop + $log.clientHeight >= $log.scrollHeight - 24; // đang ở cuối thì mới tự cuộn
      const line = document.createElement('div');
      line.style.color = ERR_RE.test(m) ? COLORS.error : OK_RE.test(m) ? COLORS.result : color;
      line.textContent = `[${new Date().toLocaleTimeString()}] ${tag} ${m}`;
      $log.appendChild(line);
      if (this.$stripLog) { this.$stripLog.textContent = line.textContent; this.$stripLog.style.color = line.style.color || ''; }
      while ($log.childElementCount > 300) $log.removeChild($log.firstChild);
      if (stick) $log.scrollTop = $log.scrollHeight;
    }

    /* ----- kéo thả bảng bằng thanh tiêu đề ----- */
    initDrag() {
      const POS_KEY = 'tt-auto-boss-pos';
      const { panel, $drag, storage } = this;
      this.place = (x, y) => { // đặt bảng tại (x, y) nhưng luôn nằm trong cửa sổ; giao diện nhỏ thì bảng dính mép phải
        if (this.isCp()) return;
        const cx = Math.min(Math.max(0, x), Math.max(0, window.innerWidth - panel.offsetWidth));
        const cy = Math.min(Math.max(0, y), Math.max(0, window.innerHeight - panel.offsetHeight));
        panel.style.left = cx + 'px'; panel.style.top = cy + 'px'; panel.style.right = 'auto'; panel.style.bottom = 'auto';
      };
      const resetPos = () => { panel.style.left = panel.style.top = ''; panel.style.right = '12px'; panel.style.bottom = '12px'; };
      const saved = storage.getJSON(POS_KEY, null);
      if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) this.place(saved.x, saved.y);
      let drag = null;
      $drag.addEventListener('pointerdown', e => {
        if (e.button !== 0 || this.isCp()) return;
        const r = panel.getBoundingClientRect();
        drag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
        try { $drag.setPointerCapture(e.pointerId); } catch (_) {}
        e.preventDefault();
      });
      $drag.addEventListener('pointermove', e => { if (drag) this.place(e.clientX - drag.dx, e.clientY - drag.dy); });
      const endDrag = () => {
        if (!drag) return;
        drag = null;
        const r = panel.getBoundingClientRect();
        storage.setJSON(POS_KEY, { x: r.left, y: r.top });
      };
      $drag.addEventListener('pointerup', endDrag);
      $drag.addEventListener('pointercancel', endDrag);
      $drag.addEventListener('dblclick', () => { if (this.isCp()) return; resetPos(); storage.remove(POS_KEY); });
      window.addEventListener('resize', () => { if (panel.style.left) { const r = panel.getBoundingClientRect(); this.place(r.left, r.top); } });
    }

    /* ----- thu nhỏ / mở rộng ----- */
    initMinimize() {
      const MIN_KEY = 'tt-auto-boss-min', PART_KEY = 'tt-auto-boss-parts';
      const { panel, storage, $body, $min, $ctrl, $minCtrl, $minLog, $log, $drag } = this;
      const parts = { ctrl: true, log: true }; // true = đang hiện
      const reclamp = () => { if (panel.style.left) { const r = panel.getBoundingClientRect(); this.place(r.left, r.top); } };
      const applyParts = save => {
        $ctrl.style.display = parts.ctrl ? '' : 'none';
        $log.style.display = parts.log ? '' : 'none';
        $minCtrl.classList.toggle('off', !parts.ctrl);
        $minLog.classList.toggle('off', !parts.log);
        if (parts.log) $log.scrollTop = $log.scrollHeight;
        if (save) storage.setJSON(PART_KEY, parts);
        reclamp();
      };
      const setMin = (m, save) => {
        $body.style.display = m ? 'none' : '';
        panel.classList.toggle('min', !!m);
        $min.textContent = m ? '+' : '−';
        if (save) storage.setRaw(MIN_KEY, m ? '1' : '0');
        reclamp();
      };
      for (const b of [$min, $minCtrl, $minLog]) { // bấm nút không kích hoạt kéo / nhấp đúp reset vị trí
        b.addEventListener('pointerdown', e => e.stopPropagation());
        b.addEventListener('dblclick', e => e.stopPropagation());
      }
      $min.addEventListener('click', () => { if (this.isCp()) { panel.classList.add('rail'); panel.classList.remove('logopen'); return; } setMin($body.style.display !== 'none', true); });
      $minCtrl.addEventListener('click', () => {
        if ($body.style.display === 'none') setMin(false, true); // đang thu nhỏ cả bảng thì mở ra rồi mới đổi phần này
        parts.ctrl = !parts.ctrl; applyParts(true);
      });
      $minLog.addEventListener('click', () => {
        if (this.isCp()) { panel.classList.toggle('logopen'); return; }
        if ($body.style.display === 'none') setMin(false, true);
        parts.log = !parts.log; applyParts(true);
      });
      const sv = storage.getJSON(PART_KEY, null);
      if (sv) { parts.ctrl = sv.ctrl !== false; parts.log = sv.log !== false; }
      applyParts(false);
      if (storage.getRaw(MIN_KEY) === '1') setMin(true, false);
    }

    /* ----- hai giao diện: máy tính (mặc định) và màn hình nhỏ cảm ứng ----- */
    initLayout() {
      const UI_KEY = 'tt-auto-boss-ui', SEEN_KEY = 'tt-auto-boss-seen';
      const { panel, storage, $ui } = this;
      const mq = typeof window.matchMedia === 'function' ? window.matchMedia('(max-width: 1100px)') : null;
      const pref = () => { const v = storage.getRaw(UI_KEY); return v === 'desktop' || v === 'compact' ? v : 'auto'; };
      const wantCp = () => { const p = pref(); return p === 'compact' || (p === 'auto' && !!mq && mq.matches); };
      const apply = first => {
        const cp = wantCp();
        panel.classList.toggle('cp', cp);
        if (cp) {
          // lần đầu mở rộng cho dễ làm quen; từ lần thứ hai trở đi mở ra là thanh thu gọn
          if (first) { if (storage.getRaw(SEEN_KEY) === '1') panel.classList.add('rail'); else storage.setRaw(SEEN_KEY, '1'); }
          else panel.classList.remove('rail');
        } else panel.classList.remove('rail', 'logopen');
        if (this.refold) this.refold();
        $ui.textContent = cp ? '🖥' : '📱';
        $ui.title = cp ? 'Đang dùng giao diện màn hình nhỏ. Chạm để đổi sang giao diện máy tính' : 'Đang dùng giao diện máy tính. Chạm để đổi sang giao diện màn hình nhỏ (cảm ứng)';
        this.renderStrip();
        if (!cp && panel.style.left) { const r = panel.getBoundingClientRect(); this.place(r.left, r.top); }
      };
      $ui.addEventListener('pointerdown', e => e.stopPropagation());
      $ui.addEventListener('dblclick', e => e.stopPropagation());
      $ui.addEventListener('click', () => { storage.setRaw(UI_KEY, this.isCp() ? 'desktop' : 'compact'); apply(false); });
      if (mq && mq.addEventListener) mq.addEventListener('change', () => { if (pref() === 'auto') apply(false); });
      panel.querySelector('#ab-rail-open').addEventListener('click', () => panel.classList.remove('rail'));
      panel.querySelectorAll('.ab-rb[data-rk]').forEach(b => b.addEventListener('click', () => {
        panel.classList.remove('rail');
        const tab = panel.querySelector(`.ab-row[data-key="${b.dataset.rk}"]`)?.closest('.ab-pane')?.dataset.pane;
        const t = tab && panel.querySelector(`.ab-tab[data-tab="${tab}"]`); if (t) t.click();
      }));
      this.$stripLog.addEventListener('click', () => { panel.classList.add('logopen'); this.$log.scrollTop = this.$log.scrollHeight; });
      apply(true);
      setTimeout(() => panel.classList.add('ready'), 600); // sau đó mới có hiệu ứng đóng ấn, tránh nháy lúc tải trang
    }
  }

  /* =====================================================================
   *  7. APP (controller): nối engine <-> view bằng sự kiện
   * ===================================================================== */
  class App {
    constructor(api) {
      this.api = api;
      this.storage = new SafeStorage();
      this.view = new PanelView(this.storage);
      // Dùng chung: khoảng cách giữa các đòn đánh, cờ ưu tiên: boss > săn yêu > tầm bảo, cấu hình đan và ngưỡng MP
      this.shared = { limiter: new RateLimiter(), coord: new Coordinator(), pills: new PillConfig(), mpGate: new MpGate(), hpGate: new HpGate(), mpCfg: new MpPillConfig(), hpCfg: new HpPillConfig(), healCfg: new HealSkillConfig(), pillBook: new PillBook() };
      this.swapper = this.shared.swapper = new SkillSwapper({ api, sleep: ms => new Promise(r => setTimeout(r, ms)) });
      const common = { api, now: () => Date.now(), rand: Math.random, sleep: ms => new Promise(r => setTimeout(r, ms)), ...this.shared };
      this.boss = new BossEngine(common);
      this.farm = new FarmEngine(common);
      this.hunt = new HuntEngine(common);
      this.bt = new BreakthroughEngine(common);
      this.pillTool = new PillManager(common); // dùng cho nút "Hồi MP ngay" (không thuộc engine nào)
      this.hpTool = new HpPillService(common, ''); this.hpNowTarget = 0.5; // dùng cho nút "Hồi HP ngay"
      this.alchemy = new AlchemyEngine(common);
      this.uminh = new UMinhEngine(common);
      this.tower = new TowerEngine(common);
      this.xh = new XuatHonEngine({ ...common, blockers: () => this.xhBlockers() }); this.xhTries = 0; this.xhTimer = null;
      this.garden = new GardenEngine(common);
      this.war = new WarEngine(common);
      this.beast = new BeastEngine(common); this.beastBusy = false; this.beastTries = 0;
      this.sell = new SellEngine(common); this.sellBusy = false; this.sellSel = null; this.sellQty = 1; this.sellList = []; this.sellTries = 0; this.sellTimer = null;
      this.chest = new BulkUseEngine(common); this.chestBusy = false; this.chestSel = null; this.chestTimer = null; this.chestTries = 0;
      this.login = new AutoLogin({ now: () => Date.now() });
      this.mem = new ModeMemory(this.storage); this.modes = {}; this.resuming = false;
      if (this.storage.getRaw('tt-auto-boss-bt') === '1') this.mem.set('bt', true); // nâng cấp từ khóa cũ của Đột phá
      this.seedTries = 0; this.seedTimer = null; this.pillTries = 0; this.pillTimer = null; this.skillTries = 0; this.skillTimer = null; this.skillInv = []; this.skillQueue = []; this.skillSlots = CFG.SKILL_SLOTS; this.skillBusy = false; this.skillRun = null; this.skillRetryAt = 0; this.realm = null;
      this.shared.coord.skillGate = () => this.flushSkillQueue(); // các chế độ gọi ngay giữa hai trận
      this.recipeTries = 0; this.recipeTimer = null;
      // trạng thái chọn yêu
      this.monsterPicked = false; this.monsterTries = 0; this.monsterTimer = null;
    }

    uiLog(m) { this.view.appendLog('[UI]', COLORS.tool, m); }
    pipeLog(engine, tag, color) { engine.on('log', m => this.view.appendLog(tag, color, m)); }

    // Watchdog: 15s xem một lần, chế độ nào lỗi liên tục quá WATCHDOG_IDLE_MS thì reset mềm
    watchdogTick() { for (const e of [this.boss, this.farm, this.hunt, this.bt, this.alchemy, this.uminh, this.tower, this.xh, this.garden, this.beast, this.war]) e.watchdog(Date.now()); }

    start() {
      const { view, boss, farm, hunt } = this;
      setInterval(() => this.watchdogTick(), 15000);
      this.pipeLog(boss, '[Boss]', COLORS.boss);
      this.pipeLog(farm, '[Tầm bảo]', COLORS.farm);
      this.pipeLog(hunt, '[Săn yêu]', COLORS.hunt);
      this.pipeLog(this.bt, '[Đột phá]', COLORS.func4);
      this.pipeLog(this.pillTool, '[Đan]', COLORS.func5);
      this.pipeLog(this.hpTool, '[Đan]', COLORS.func5);
      api.onLog = m => this.uiLog(m); // hàng chờ lệnh: cảnh báo chờ lâu / server báo gọi quá nhiều
      setInterval(() => { if (!document.hidden) this.view.setReq(api.queue.stats()); }, 1000); // tab ẩn thì không vẽ lại this.view.setReq(api.queue.stats());
      this.pipeLog(this.alchemy, '[Luyện đan]', COLORS.func6);
      this.pipeLog(this.uminh, '[U Minh]', COLORS.func7);
      this.pipeLog(this.tower, '[Leo tháp]', COLORS.tower);
      this.pipeLog(this.xh, '[Xuất hồn]', COLORS.xh);
      this.pipeLog(this.swapper, '[Đổi chiêu]', COLORS.swap);
      this.pipeLog(this.login, '[Đăng nhập]', COLORS.func4);
      this.pipeLog(this.garden, '[Linh điền]', COLORS.func8);
      this.pipeLog(this.beast, '[Yêu thú]', COLORS.func8);
      this.pipeLog(this.war, '[Tông Chiến]', COLORS.war);

      this.bindBoss(); this.bindFarm(); this.bindHunt(); this.bindMp(); this.bindPills(); this.bindHealSkill(); this.bindSkills(); this.bindBreakthrough(); this.bindAlchemy(); this.bindUMinh(); this.bindTower(); this.bindXuatHon(); this.bindGarden(); this.bindWar(); this.bindBeast(); this.bindChest(); this.bindSell(); this.bindLogin();
      view.init();
      farm.st.zone = view.zone;
      this.loadMonsters();
      this.loadXh();
      this.loadRecipes();
      this.loadSeeds();
      this.loadBeastInfo();
      this.loadChest();
      this.loadSell();
      this.loadBtPills();
      this.loadPills();
      this.loadSkills();
      this.bindResume();

      // Cảnh báo nếu còn bản script cũ (tên khác, vd. "… v2.x.x") chạy song song: mỗi bản có tên riêng thì Tampermonkey không tự thay thế nhau
      setTimeout(() => {
        if (PanelView.panelCount() > 1)
          this.uiLog(`⚠ Phát hiện nhiều bản script cùng chạy (bản này là v${VERSION}). Vào Tampermonkey tắt/xóa bản cũ, nếu không sẽ đánh trùng.`);
      }, 2500);
      this.uiLog(`Đã tải v${VERSION}. Kéo thanh tiêu đề để di chuyển bảng, nhấp đúp để đưa về góc phải dưới.`);
    }

    // nút bật/tắt chung cho boss, tầm bảo, săn yêu
    bindToggle(key, engine, beforeRun) {
      this.modes[key] = { engine, beforeRun };
      engine.on('stop', () => { this.view.setRunning(key, false); this.mem.onSelfStop(key, this.authLost()); this.showMem(); });
      this.view.on(`${key}:toggle`, () => {
        if (engine.st.running) { this.mem.set(key, false); engine.stop(); this.view.setRunning(key, false); }
        else { this.mem.set(key, true); this.startMode(key); }
        this.showMem();
      });
    }

    // thấy màn hình đăng nhập, hoặc vừa bị 401 trong 2 phút gần đây => coi là mất phiên
    authLost() { return !!AutoLogin.find(document) || Date.now() - (this.api.lastUnauthorized || 0) < 120000; }
    isRunning(key) { return key === 'bt' ? !!this.bt.st.running : !!(this.modes[key] && this.modes[key].engine.st.running); }
    startMode(key) {
      if (key === 'bt') { this.view.setBtChecked(true); this.bt.run(); return; }
      const m = this.modes[key]; if (!m) return;
      if (m.beforeRun) m.beforeRun();
      this.view.setRunning(key, true); m.engine.run();
    }
    showMem() {
      const l = this.mem.list();
      this.view.setResumeInfo(l.length ? `Đang nhớ: ${l.map(ModeMemory.label).join(', ')}.` : 'Chưa nhớ chế độ nào (bật một chế độ để tool nhớ).');
    }
    // đợi tới khi game đã đăng nhập (không còn form đăng nhập và gọi được API), rồi bật lại các chế độ đã nhớ
    async resumeModes(why) {
      const { mem } = this;
      if (this.resuming || !mem.resumeOn) return;
      if (!mem.pending(k => this.isRunning(k)).length) return;
      this.resuming = true;
      try {
        this.uiLog(`Tự chạy lại (${why}): ${mem.pending(k => this.isRunning(k)).map(ModeMemory.label).join(', ')}. Đang chờ phiên đăng nhập...`);
        const sleep = this.shared.sleep || (ms => new Promise(r => setTimeout(r, ms)));
        let ok = false;
        for (let i = 0; i < 60 && !ok; i++) {
          if (!AutoLogin.find(document)) { try { await this.api.getMe(); ok = true; break; } catch (_) {} }
          await sleep(3000);
        }
        if (!ok) { this.uiLog('Chưa đăng nhập được sau ~3 phút nên chưa bật lại chế độ nào; sẽ thử lại khi đăng nhập xong.'); return; }
        for (const k of mem.pending(x => this.isRunning(x))) {
          if (!mem.resumeOn) break;
          try {
            if (k === 'hunt' && !this.hunt.st.monsterId) await this.loadMonsters();
            if (k === 'alchemy' && !this.alchemy.st.recipeId) await this.loadRecipes();
            if (k === 'garden' && !this.garden.st.seedId) await this.loadSeeds();
            this.uiLog(`Tự bật lại: ${ModeMemory.label(k)}`);
            this.startMode(k);
          } catch (e) { this.uiLog(`Không bật lại được ${ModeMemory.label(k)}: ${e.message}`); }
          await sleep(1500);
        }
      } finally { this.resuming = false; }
    }
    bindResume() {
      const { view, mem, login } = this;
      view.setResume(mem.resumeOn);
      view.on('resume:toggle', on => { mem.setResume(on); this.uiLog(`Tự chạy lại sau đăng nhập: ${on ? 'BẬT' : 'TẮT'}.`); if (on) this.resumeModes('bật lại tùy chọn'); });
      login.on('done', () => setTimeout(() => this.resumeModes('vừa đăng nhập'), 3000));
      this.showMem();
      if (mem.resumeOn) setTimeout(() => this.resumeModes('mở trang'), 1500);
      else if (mem.wants('bt')) { view.setBtChecked(true); setTimeout(() => this.bt.run(), 4000); } // giữ hành vi cũ của Đột phá
    }

    bindBoss() {
      const { view, boss } = this;
      const KEY = 'tt-auto-boss-boss-opts', st = this.storage;
      const o = st.getJSON(KEY, null);
      if (o && o.sizes) { for (const z of ['small', 'medium', 'large']) if (typeof o.sizes[z] === 'boolean') boss.st.enabled[z] = o.sizes[z]; view.setBossOpts(boss.st.enabled); }
      if (o && o.modes) { for (const z of ['small', 'medium', 'large']) if (BossCatalog.MODES.includes(o.modes[z])) boss.st.modes[z] = o.modes[z]; }
      view.setBossModes(boss.st.modes);
      const save = () => st.setJSON(KEY, { sizes: { ...boss.st.enabled }, modes: { ...boss.st.modes } });
      view.on('boss:size', (size, checked) => { boss.st.enabled[size] = checked; save(); });
      view.on('boss:mode', (size, mode) => { if (!BossCatalog.MODES.includes(mode)) return; boss.st.modes[size] = mode; save(); });
      this.bindToggle('boss', boss);
    }

    bindFarm() {
      const { view, farm } = this;
      const ZK = 'tt-auto-boss-farm-zone', sz = this.storage.getRaw(ZK);
      if (sz) view.setZone(sz);
      view.on('farm:zone', code => { farm.st.zone = code; this.storage.setRaw(ZK, code); });
      farm.on('tickets', n => view.setFarmTickets(n, farm.st.maxTickets));
      this.bindToggle('farm', farm, () => { farm.st.zone = view.zone; });
    }

    bindHunt() {
      const { view, hunt } = this;
      view.on('hunt:monster', id => { this.monsterPicked = true; hunt.st.monsterId = id; });
      view.on('hunt:refresh', () => { this.monsterTries = 0; this.loadMonsters(); });
      hunt.on('tickets', n => view.setTickets(n)); // số vé lấy từ phản hồi của chính engine, không gọi thêm API
      this.bindToggle('hunt', hunt);
    }

    async loadMonsters() {
      const { api, view, hunt } = this;
      clearTimeout(this.monsterTimer);
      try {
        const [list, me] = await Promise.all([api.getMonsters(), api.getMe().catch(() => null)]);
        const realm = me && typeof me.realm_id === 'number' ? me.realm_id : null;
        const sorted = MonsterCatalog.sort(list);
        if (!sorted.length) throw new Error('danh sách trống');
        const keep = this.monsterPicked ? sorted.find(m => m.id === view.monsterValue && MonsterCatalog.canFight(m, realm)) : null;
        const sel = keep || MonsterCatalog.pickDefault(sorted, realm) || sorted[0];
        view.setMonsters(sorted, realm, sel.id);
        hunt.st.monsterId = sel.id;
        if (!keep) this.monsterPicked = false;
        this.monsterTries = 0;
        this.uiLog(`Đã tải ${sorted.length} yêu${realm != null ? ` (cảnh giới của bạn: ${realm})` : ''}. ${keep ? 'Giữ lựa chọn' : 'Mặc định'}: ${MonsterCatalog.label(sel, realm)}`);
      } catch (e) {
        // thường là chưa bắt được token đăng nhập của game: thử lại vài lần
        if (++this.monsterTries <= 30) this.monsterTimer = setTimeout(() => this.loadMonsters(), 3000);
        else this.uiLog(`Không tải được danh sách yêu: ${e.message}. Bấm ↻ để thử lại.`);
      }
    }

    // U Minh Cốc: chọn cổng + nút bật/tắt + dòng trạng thái
    bindUMinh() {
      const { view, uminh, storage } = this;
      const KEY = 'tt-auto-boss-um-gate';
      const saved = storage.getRaw(KEY) || 'auto';
      view.setUMinhGate(saved); uminh.st.spawn = saved;
      view.on('um:gate', v => { uminh.st.spawn = v; storage.setRaw(KEY, v); });
      uminh.on('status', t => view.setUMinhStatus(t));
      uminh.on('stop', () => view.setUMinhStatus(''));
      this.bindToggle('um', uminh);
    }

    // tự đăng nhập: 2 ô tên / mật khẩu + công tắc; kiểm tra màn hình đăng nhập mỗi giây
    bindLogin() {
      const { view, login, storage } = this;
      const KEY = 'tt-auto-boss-login';
      const saved = storage.getJSON(KEY, null) || {};
      const cfg = { enabled: !!saved.enabled, user: String(saved.user || ''), pass: String(saved.pass || '') };
      view.setLogin(cfg); login.configure(cfg);
      view.on('login:config', c => { login.configure(c); storage.setJSON(KEY, { enabled: !!c.enabled, user: c.user, pass: c.pass }); if (!c.enabled) view.setLoginStatus(''); });
      login.on('status', (t, k) => view.setLoginStatus(t, k));
      login.on('disabled', () => { const c = { ...login.cfg }; view.setLogin(c); storage.setJSON(KEY, { enabled: false, user: c.user, pass: c.pass }); });
      setInterval(() => { try { login.step(); } catch (_) {} }, 1000);
    }

    // leo tháp: nút bật/tắt + dòng trạng thái (tầng, thắng, thua liên tiếp)
    bindTower() {
      const { view, tower } = this;
      tower.on('status', t => view.setTowerStatus(t));
      this.bindToggle('tower', tower, () => view.setTowerStatus(''));
    }

    // xuất hồn chỉ chạy khi U Minh Cốc đã đi xong (hoặc tắt) và tầm bảo hết vé (hoặc tắt); trả lý do đang bị chặn, '' = được chạy
    xhBlockers() {
      if (this.uminh.sessionPending) return 'U Minh Cốc đang bật, chờ đi xong phiên';
      if (this.farm.st.running && this.farm.st.tickets !== 0) return 'tầm bảo đang bật và còn vé';
      return '';
    }
    bindXuatHon() {
      const { view, xh, storage } = this;
      const MK = 'tt-auto-boss-xh-map', DK = 'tt-auto-boss-xh-dur';
      xh.st.mapSel = storage.getRaw(MK) || 'auto';
      const d = Number(storage.getRaw(DK)); xh.st.duration = XuatHonCatalog.DURATIONS.includes(d) ? d : CFG.XH_DEFAULT_DURATION;
      view.setXhChoice(xh.st.mapSel, xh.st.duration);
      view.on('xh:map', v => { xh.st.mapSel = v || 'auto'; storage.setRaw(MK, xh.st.mapSel); xh.st.ver++; this.showXh(); });
      view.on('xh:dur', n => { if (!Number.isFinite(n) || n <= 0) return; xh.st.duration = n; storage.setRaw(DK, String(n)); xh.st.ver++; this.showXh(); });
      xh.on('maps', () => this.showXh());
      xh.on('status', t => view.setXhStatus(t));
      xh.on('stop', () => view.setXhStatus(''));
      this.bindToggle('xh', xh);
    }
    showXh() {
      const { xh, view } = this;
      view.setXhMaps(xh.st.maps, xh.st.mapSel, xh.st.durations, xh.st.duration);
      const m = XuatHonCatalog.pick(xh.st.maps, xh.st.mapSel), r = XuatHonCatalog.reward(m, xh.st.duration);
      view.setXhInfo(m ? `Mỗi lượt${r ? `: +${r.exp} tu vi, +${r.stones} linh thạch khóa` : ''} (${m.name}).` : '');
    }
    async loadXh() {
      const { api, xh } = this;
      clearTimeout(this.xhTimer);
      try {
        const d = await api.xhOptions();
        if (!d || !Array.isArray(d.maps) || !d.maps.length) throw new Error('danh sách trống');
        xh.st.maps = d.maps; xh.st.mapsAt = Date.now();
        if (Array.isArray(d.durations) && d.durations.length) xh.st.durations = d.durations.map(Number);
        this.xhTries = 0; this.showXh();
        const best = XuatHonCatalog.best(d.maps);
        this.uiLog(`Đã tải ${d.maps.length} bản đồ xuất hồn. Cao nhất có thể: ${best ? best.name : '(chưa mở khóa bản đồ nào)'}.`);
      } catch (e) {
        if (++this.xhTries <= 30) this.xhTimer = setTimeout(() => this.loadXh(), 3000); // thường là chưa bắt được token đăng nhập
        else this.uiLog(`Không tải được danh sách bản đồ xuất hồn: ${e.message}.`);
      }
    }

    // võ kỹ: tháo / trang bị chiêu + tự đổi chiêu khắc hệ
    bindSkills() {
      const { view, storage, swapper } = this;
      const SWAP_KEY = 'tt-auto-boss-autoswap';
      const on = storage.getRaw(SWAP_KEY) !== '0';
      swapper.enabled = on; view.setAutoSwap(on);
      const POOL_KEY = 'tt-auto-boss-swap-pool', LOCK_KEY = 'tt-auto-boss-swap-lock';
      const ids = k => (storage.getJSON(k, null) || []).filter(n => Number.isFinite(n));
      // game đổi cách quản lý chiêu: id chiêu giờ là item_id (trước là id túi đồ, không quy đổi lại được) → xóa ô dự bị / khóa cũ, bạn chọn lại
      const IDV_KEY = 'tt-auto-boss-skill-idv';
      if (storage.getRaw(IDV_KEY) !== '2') {
        const had = ids(POOL_KEY).length + ids(LOCK_KEY).length > 0;
        storage.setJSON(POOL_KEY, []); storage.setJSON(LOCK_KEY, []); storage.setRaw(IDV_KEY, '2');
        if (had) setTimeout(() => this.uiLog('Game đã đổi cách quản lý chiêu thức: ô dự bị và chiêu khóa 🔒 cũ đã được xóa, hãy chọn lại ở tab Hành trang.'), 1500);
      }
      swapper.pool = new Set(ids(POOL_KEY)); swapper.locked = new Set(ids(LOCK_KEY));
      view.on('swap:pool', list => { swapper.pool = new Set(list); storage.setJSON(POOL_KEY, [...swapper.pool]); this.renderSkills(); this.uiLog(swapper.pool.size ? `Chiêu dùng để thay: ${[...swapper.pool].map(id => (this.skillInv.find(x => x.id === id) || {}).name || '#' + id).join(', ')}.` : 'Chiêu dùng để thay: để trống → dùng mọi chiêu đang sở hữu.'); });
      view.on('skill:lock', id => {
        if (swapper.locked.has(id)) swapper.locked.delete(id); else swapper.locked.add(id);
        storage.setJSON(LOCK_KEY, [...swapper.locked]); this.renderSkills();
        const it = this.skillInv.find(x => x.id === id);
        this.uiLog(`${swapper.locked.has(id) ? 'Khóa' : 'Mở khóa'} chiêu "${it ? it.name : '#' + id}" (tự đổi chiêu ${swapper.locked.has(id) ? 'sẽ không tháo chiêu này' : 'được tháo lại'}).`);
      });
      view.on('swap:toggle', v => { swapper.enabled = v; storage.setRaw(SWAP_KEY, v ? '1' : '0'); this.uiLog(`${v ? 'Bật' : 'Tắt'} tự đổi chiêu khắc hệ (chỉ trước boss).`); });
      swapper.on('change', (inv, slots) => { this.skillSigBase = null; if (Array.isArray(inv)) { this.skillInv = inv; if (slots > 0) this.skillSlots = slots; this.renderSkills(); } });
      // tool tự đổi chiêu xong: ô dự bị chứa chiêu vừa gắn đổi thành chiêu vừa tháo
      swapper.on('pool', rot => { storage.setJSON(POOL_KEY, rot.pool); this.logRotate(rot, 'Tool đổi chiêu'); });
      // quét định kỳ: nếu bộ chiêu trong game khác với thông tin trên tool (bạn đổi tay ngoài game) thì xử lý như trên
      this.skillSigBase = null; this.scanBusy = false;
      this.reconcile = async () => {
        const book = await this.api.getSkillBook(), inv = book.skills; this.skillSlots = book.slots;
        const prevEq = SkillCatalog.equipped(this.skillInv), newEq = SkillCatalog.equipped(inv);
        const rot = SkillCatalog.rotateByDiff(prevEq, newEq, [...swapper.pool], swapper.locked);
        const changed = prevEq.map(x => x.id).sort().join() !== newEq.map(x => x.id).sort().join();
        this.skillInv = inv;
        if (rot.changes.length) { swapper.pool = new Set(rot.pool); storage.setJSON(POOL_KEY, rot.pool); this.logRotate(rot, 'Phát hiện bạn đổi chiêu ngoài tool'); }
        else if (changed) this.uiLog('Phát hiện bộ chiêu trong game đã đổi ngoài tool, đã cập nhật lại danh sách (ô dự bị không bị ảnh hưởng).');
        this.renderSkills();
      };
      setInterval(() => this.scanSkills(), CFG.SKILL_SCAN_MS);
      setInterval(() => this.flushSkillQueue(), CFG.SKILL_QUEUE_POLL_MS); // lệnh đổi chiêu bị hoãn vì đang trong trận: hết trận thì đổi
      view.on('skill:refresh', () => { this.skillTries = 0; this.loadSkills(); });
      view.on('skill:unequip', id => this.changeSkill('unequip', id));
      view.on('skill:cancel', id => this.cancelSkill(id));
      view.on('skill:equip', id => this.changeSkill('equip', id));
    }

    logRotate(rot, who) {
      const nm = x => `"${x.name}"`;
      this.uiLog(`${who}: ô dự bị ${rot.changes.map(c => `${nm(c.from)} → ${nm(c.to)}`).join(', ')}.`);
      this.renderSkills();
    }
    static skillSig(list) { return (list || []).map(s => s.name || ('#' + s.id)).sort().join('|'); }
    async scanSkills() {
      if (this.scanBusy || this.skillBusy || this.swapper.busy || !this.skillInv.length || !this.api.getSkills) return;
      this.scanBusy = true;
      try {
        const cur = await this.api.getSkills();
        if (!Array.isArray(cur)) return;
        const sig = App.skillSig(cur);
        if (this.skillSigBase == null) { this.skillSigBase = sig; return; } // mốc đầu tiên (hoặc sau khi tool tự đổi)
        if (sig === this.skillSigBase) return;
        this.skillSigBase = sig;
        await this.reconcile();
      } catch (_) {} finally { this.scanBusy = false; }
    }

    renderSkills() { this.view.setSkills(this.skillInv, this.realm, this.skillBusy, { pool: this.swapper.pool, locked: this.swapper.locked, slots: this.skillSlots, pending: this.skillQueue.slice() }); }

    async loadSkills() {
      const { api } = this;
      clearTimeout(this.skillTimer);
      try {
        const book = await api.getSkillBook(); this.skillInv = book.skills; this.skillSlots = book.slots;
        try { const me = await api.getMe(); if (me && typeof me.realm_id === 'number') { this.realm = me.realm_id; this.swapper.realm = me.realm_id; } } catch (_) {}
        this.skillTries = 0; this.renderSkills();
      } catch (e) {
        if (++this.skillTries <= 30) this.skillTimer = setTimeout(() => this.loadSkills(), 3000);
        else this.uiLog(`Không tải được danh sách chiêu: ${e.message}. Bấm ↻ để thử lại.`);
      }
    }

    // Game từ chối đổi chiêu khi đang trong trận (vd. "Đang trong trận Săn Yêu, hãy hoàn thành hoặc bỏ qua trước khi giao chiến nơi khác.")
    static isBattleError(e) { return /đang trong trận|hoàn thành hoặc bỏ qua|giao chiến nơi khác/i.test((e && e.message) || ''); }
    skillOpText(q) { return `${q.kind === 'equip' ? 'gắn' : 'tháo'} "${q.name}"`; }
    updateSkillPending() { this.view.setSkillPending(this.skillQueue.length ? `Chờ hết trận (đổi ngay sau trận) để đổi chiêu: ${this.skillQueue.map(q => this.skillOpText(q)).join(', ')}.` : ''); }
    // lưu lệnh đổi chiêu tạm, hết trận (không chế độ nào đang đánh) mới thực hiện. Cùng một chiêu thì lệnh sau thay lệnh trước.
    queueSkill(kind, id, name) {
      this.skillQueue = this.skillQueue.filter(q => q.id !== id); this.skillQueue.push({ kind, id, name });
      this.uiLog(`Lưu lại lệnh ${this.skillOpText({ kind, name })}, sẽ đổi ngay sau trận này.`);
      this.updateSkillPending(); this.renderSkills();
    }
    // Thực hiện các lệnh đổi chiêu đang chờ khi không còn trận nào dở. Trả promise (chế độ gọi từ cổng sẽ đợi nó, nên trận mới không mở giữa lúc đang đổi),
    // hoặc null nếu không có việc / chưa phải lúc.
    flushSkillQueue() {
      if (this.skillRun) return this.skillRun;
      if (!this.skillQueue.length || this.skillBusy || this.shared.coord.fighting || Date.now() < this.skillRetryAt) return null;
      this.skillRun = this.runSkillQueue().finally(() => { this.skillRun = null; });
      return this.skillRun;
    }
    async runSkillQueue() {
      this.skillBusy = true; this.renderSkills();
      try {
        while (this.skillQueue.length && !this.shared.coord.fighting) {
          const q = this.skillQueue[0];
          try {
            const d = await (q.kind === 'equip' ? this.api.equipSkill(q.id) : this.api.unequipSkill(q.id));
            if (d && Array.isArray(d.skills)) { this.skillInv = d.skills; this.skillSlots = d.slots; }
            this.skillQueue.shift(); this.skillSigBase = null;
            this.uiLog(`Đã ${q.kind === 'equip' ? 'trang bị' : 'tháo'} chiêu "${q.name}" (lệnh chờ hết trận).`);
          } catch (e) {
            if (App.isBattleError(e)) { this.skillRetryAt = Date.now() + CFG.SKILL_RETRY_MS; break; } // vẫn còn trận (của game): giữ lệnh, thử lại ở khoảng nghỉ sau
            this.skillQueue.shift(); this.uiLog(`Lỗi ${q.kind === 'equip' ? 'trang bị' : 'tháo'} chiêu "${q.name}": ${e.message}`);
          }
        }
      } finally { this.skillBusy = false; this.updateSkillPending(); this.renderSkills(); }
    }
    cancelSkill(id) {
      const q = this.skillQueue.find(x => x.id === id); if (!q) return;
      this.skillQueue = this.skillQueue.filter(x => x.id !== id);
      this.uiLog(`Đã hủy lệnh ${this.skillOpText(q)}.`);
      this.updateSkillPending(); this.renderSkills();
    }

    async changeSkill(kind, id) {
      if (this.skillBusy) return;
      const it = this.skillInv.find(x => x.id === id), name = it ? it.name : `#${id}`;
      if (this.shared.coord.fighting || this.skillQueue.length) { this.queueSkill(kind, id, name); return; } // đang có trận (khỏi gọi server), hoặc còn lệnh chờ: xếp hàng cho đúng thứ tự (tháo trước, gắn sau)
      this.skillBusy = true; this.renderSkills();
      try {
        const d = await (kind === 'equip' ? this.api.equipSkill(id) : this.api.unequipSkill(id));
        if (d && Array.isArray(d.skills)) { this.skillInv = d.skills; this.skillSlots = d.slots; }
        else { const b = await this.api.getSkillBook(); this.skillInv = b.skills; this.skillSlots = b.slots; }
        this.skillSigBase = null; // đổi bằng nút trên tool: không coi là đổi ngoài tool
        this.skillQueue = this.skillQueue.filter(q => q.id !== id); this.updateSkillPending();
        this.uiLog(`${kind === 'equip' ? 'Đã trang bị' : 'Đã tháo'} chiêu "${name}". Chiêu mới áp dụng từ trận kế tiếp (trận đang đánh giữ bộ chiêu cũ).`);
      } catch (e) {
        this.uiLog(`Lỗi ${kind === 'equip' ? 'trang bị' : 'tháo'} chiêu "${name}": ${e.message}`);
        if (App.isBattleError(e)) this.queueSkill(kind, id, name);
        else { try { const b = await this.api.getSkillBook(); this.skillInv = b.skills; this.skillSlots = b.slots; } catch (_) {} }
      } finally { this.skillBusy = false; this.renderSkills(); }
    }

    // đan sử dụng (HP / MP) + đan hồi HP theo từng chế độ
    bindPills() {
      const { view, api, storage } = this;
      const book = this.shared.pillBook, hc = this.shared.hpCfg;
      const BOOK_KEY = 'tt-auto-boss-pillbook', HP_KEY = 'tt-auto-boss-hp-pill';
      const saved = storage.getJSON(BOOK_KEY, null) || {};
      for (const k of ['hp', 'mp']) if (saved[k] && saved[k].id != null) book.sel[k] = { id: saved[k].id, name: saved[k].name || '' };
      // x = low (mặc định 5), y = target (bản cũ chỉ có y: 10 – 30)
      this.bindDual('hp', hc.modes, ['low', 'target'], ['low', 'target'], HP_KEY, storage.getJSON(HP_KEY, null), false, 'dùng đan hồi HP');
      // đan hồi MP theo từng chế độ. Bản cũ chỉ có 1 cấu hình chung (tt-auto-boss-pill-on + thanh tt-auto-boss-pill): chép sang mọi chế độ khi chưa có cấu hình mới
      const mc = this.shared.mpCfg, MP_KEY = 'tt-auto-boss-mp-pill';
      let mv = storage.getJSON(MP_KEY, null);
      if (!mv) {
        const old = storage.getJSON('tt-auto-boss-pill', null) || {}, ok5 = v => Number.isInteger(v) && v % 5 === 0 && v >= 5 && v <= 95;
        const lo = ok5(old.lo) ? old.lo : Math.round(CFG.MP_PILL_DEFAULT_LOW * 100), hi = ok5(old.hi) && old.hi > lo ? old.hi : Math.round(CFG.MP_PILL_DEFAULT_HIGH * 100);
        const on = !!storage.getJSON('tt-auto-boss-pill-on', false);
        mv = Object.fromEntries(Object.keys(mc.modes).map(k => [k, { enabled: on, low: lo, high: hi }]));
      }
      this.bindDual('mp', mc.modes, ['low', 'high'], ['low', 'high'], MP_KEY, mv, false, 'dùng đan hồi MP');
      const saveBook = () => storage.setJSON(BOOK_KEY, { hp: book.sel.hp, mp: book.sel.mp });
      view.on('pillbook:select', (kind, id, name) => { book.select(kind, id, name); saveBook(); });
      view.on('pillbook:refresh', () => { this.pillTries = 0; this.loadPills(); });
      book.on('change', () => view.setPillBook(book));
      this.saveBook = saveBook;
      book.on('autoswitch', () => saveBook()); // hết loại đan đã chọn → tự chuyển sang loại khác: lưu lựa chọn mới
    }

    // mức hồi máu của chiêu hồi máu (x% – y%) theo từng chế độ (không có xuất hồn), lưu trong localStorage
    bindHealSkill() {
      const { view, storage } = this;
      const KEY = 'tt-auto-boss-heal-skill', hs = this.shared.healCfg, ks = Object.keys(hs.modes);
      const sv = storage.getJSON(KEY, null) || {};
      const five = v => Number.isInteger(v) && v % 5 === 0;
      for (const k of ks) {
        const m = hs.modes[k], o = sv[k] || {};
        if (five(o.low) && five(o.high) && o.low >= 5 && o.high <= 95 && o.low < o.high) { m.low = o.low / 100; m.high = o.high / 100; }
        view.setHealRange(k, Math.round(m.low * 100), Math.round(m.high * 100));
      }
      const save = () => storage.setJSON(KEY, Object.fromEntries(ks.map(k => [k, { low: Math.round(hs.modes[k].low * 100), high: Math.round(hs.modes[k].high * 100) }])));
      view.on('heal:range', (k, lo, hi) => { hs.modes[k].low = lo / 100; hs.modes[k].high = hi / 100; save(); });
      // nút "Hồi HP ngay": dùng đan hồi HP đã chọn tới mức của thanh trượt đơn, không cần đang có trận chiến
      view.on('hpnow:range', v => { this.hpNowTarget = v / 100; });
      view.on('hpnow:go', async () => {
        view.setHpNowBusy(true);
        try { await this.hpTool.refill(this.hpNowTarget); } finally { view.setHpNowBusy(false); }
      });
    }

    async loadPills() {
      const { api } = this; const book = this.shared.pillBook;
      clearTimeout(this.pillTimer);
      try {
        book.update(await api.getInventory());
        const a = book.autoSelect('hp'), b = book.autoSelect('mp');
        if (a || b) this.saveBook();
        this.pillTries = 0;
        this.uiLog(`Đã tải đan: ${book.list('hp').length} loại hồi HP, ${book.list('mp').length} loại hồi MP.`);
      } catch (e) {
        if (++this.pillTries <= 30) this.pillTimer = setTimeout(() => this.loadPills(), 3000);
        else this.uiLog(`Không tải được túi đồ: ${e.message}. Bấm ↻ để thử lại.`);
      }
    }

    // linh điền: droplist hạt giống + nút bật/tắt + báo linh thạch
    bindGarden() {
      const { view, garden, storage } = this;
      const KEY = 'tt-auto-boss-garden-seed';
      view.on('garden:seed', id => { garden.st.seedId = id; storage.setJSON(KEY, id); this.refreshStonesHint(); });
      view.on('garden:refresh', () => { this.seedTries = 0; this.loadSeeds(); });
      const OPT_KEY = 'tt-auto-boss-garden-opts';
      const o = storage.getJSON(OPT_KEY, null) || {};
      garden.st.harvestOn = o.harvest !== false; garden.st.plantOn = o.plant !== false;
      view.setGardenOpts(garden.st.harvestOn, garden.st.plantOn);
      const saveOpts = () => { storage.setJSON(OPT_KEY, { harvest: garden.st.harvestOn, plant: garden.st.plantOn }); view.setGardenOpts(garden.st.harvestOn, garden.st.plantOn); };
      view.on('garden:harvest', on => { garden.st.harvestOn = on; saveOpts(); this.uiLog(`Linh điền: Thu hoạch ${on ? 'BẬT' : 'TẮT'}.`); });
      view.on('garden:plant', on => { garden.st.plantOn = on; saveOpts(); this.uiLog(`Linh điền: Trồng thêm ${on ? 'BẬT' : 'TẮT'}.`); });
      garden.on('start', () => view.setGardenRunning(true)); garden.on('stop', () => view.setGardenRunning(false));
      garden.on('stones', s => view.setGardenStones(s.text, s.ok));
      garden.on('status', t => view.setGardenStatus(t));
      garden.on('stop', () => { view.setGardenStatus(''); });
      this.bindToggle('garden', garden);
    }

    // Tông Chiến: lãnh địa đang chọn tay được nhớ cùng hạn (20:55); hết hạn thì bỏ
    bindWar() {
      const { view, war, storage } = this;
      const KEY = 'tt-auto-boss-war-terr';
      const c = storage.getJSON(KEY, null);
      if (c && typeof c.code === 'string' && Number(c.until) > Date.now()) war.st.choice = { code: c.code, until: Number(c.until) };
      view.on('war:terr', v => war.setChoice(v === 'auto' ? null : v));
      war.on('choice', ch => storage.setJSON(KEY, ch));
      war.on('territories', (list, code, chosen) => view.setWarTerritories(list, code, chosen));
      war.on('info', t => view.setWarInfo(t));
      war.on('status', t => view.setWarStatus(t));
      war.on('stop', () => { view.setWarStatus(''); });
      this.bindToggle('war', war);
    }

    // yêu thú: bộ lọc phóng sinh (được nhớ), nút tay Mở trứng / Phóng sinh ngay (có xác nhận khi gồm Sử thi / Huyền thoại), công tắc tự động
    bindBeast() {
      const { view, beast, storage } = this;
      const KEY = 'tt-auto-boss-beast';
      beast.st.filter = BeastCatalog.normalize(storage.getJSON(KEY, null));
      view.setBeastFilter(beast.st.filter);
      beast.on('info', i => view.setBeastInfo(`Trứng: ${i.eggs} · Yêu Thú Các: ${i.count}/${CFG.BEAST_CAP}`));
      beast.on('stop', () => view.setBeastInfo(view.$beastInfo.textContent));
      view.on('beast:filter', f => { beast.st.filter = BeastCatalog.normalize(f); storage.setJSON(KEY, beast.st.filter); beast.st.ver++; });
      const manual = async fn => {
        if (this.beastBusy) return;
        this.beastBusy = true; view.setBeastBusy(true);
        try { await fn(); } catch (e) { this.uiLog(`Yêu thú: ${e.message}`); }
        finally { this.beastBusy = false; view.setBeastBusy(false); }
      };
      view.on('beast:hatch', () => manual(() => beast.manualHatch()));
      view.on('beast:release', () => manual(async () => {
        const list = await beast.manualCandidates();
        if (!list.length) { this.uiLog('Phóng sinh: không có con nào khớp bộ lọc (hoặc đều đang được bảo vệ).'); return; }
        const high = list.filter(b => BeastCatalog.HIGH.includes(b.rarity));
        if (high.length) {
          const msg = `⚠ CẢNH BÁO: sắp phóng sinh ${list.length} con, trong đó có ${high.length} con SỬ THI / HUYỀN THOẠI. Phóng sinh KHÔNG hoàn lại được.\n\n${high.map(BeastCatalog.label).join('\n')}\n\nBạn chắc chắn muốn phóng sinh?`;
          if (!view.confirm(msg)) { this.uiLog('Đã hủy phóng sinh.'); return; }
        }
        this.uiLog(`Phóng sinh ${list.length} con...`);
        const ids = await beast.manualRelease(list);
        this.uiLog(`Đã phóng sinh ${ids.length}/${list.length} con.`);
      }));
      this.bindToggle('beast', beast);
    }

    // mở nhiều: droplist vật phẩm mở được (nhớ loại đã chọn), tự làm mới khi mở tab Hành trang và sau mỗi lượt
    bindChest() {
      const { view, chest, storage } = this;
      const KEY = 'tt-auto-boss-chest';
      this.chestSel = storage.getJSON(KEY, null);
      chest.on('log', m => this.uiLog(m));
      chest.on('status', t => view.setChestStatus(t));
      chest.on('inventory', inv => this.showChest(inv));
      chest.on('bagfull', () => { for (const e of [this.farm, this.hunt, this.tower, this.uminh]) { e.st.bagFull = true; e.st.bagCount = null; } });
      view.on('chest:select', key => { this.chestSel = key; storage.setJSON(KEY, key); });
      view.on('chest:refresh', () => { this.chestTries = 0; this.loadChest(); });
      view.on('tab', name => { if (name === 'kit' && !this.chestBusy) this.loadChest(); });
      view.on('chest:go', async () => {
        if (this.chestBusy) { chest.stop(); view.setChestStatus('Đang dừng sau lượt hiện tại...'); return; }
        if (this.chestSel == null) { this.uiLog('Mở nhiều: chưa chọn vật phẩm.'); return; }
        this.chestBusy = true; view.setChestBusy(true);
        try { await chest.run(this.chestSel); }
        catch (e) { this.uiLog(`Mở nhiều: ${e.message}`); }
        finally { this.chestBusy = false; view.setChestBusy(false); }
      });
    }
    // bán đồ: droplist vật phẩm + số lượng + xem trước, có xác nhận; nhớ vật phẩm và số lượng đã chọn
    bindSell() {
      const { view, sell, storage } = this;
      const KEY = 'tt-auto-boss-sell';
      const sv = storage.getJSON(KEY, null) || {};
      this.sellSel = sv.key == null ? null : sv.key; this.sellQty = Math.max(1, Math.floor(Number(sv.qty)) || 1); view.setSellQty(this.sellQty);
      const save = () => storage.setJSON(KEY, { key: this.sellSel, qty: this.sellQty });
      sell.on('log', m => this.uiLog(m));
      sell.on('status', t => view.setSellStatus(t));
      sell.on('inventory', inv => this.showSell(inv));
      view.on('sell:select', key => { this.sellSel = key; save(); this.previewSell(); });
      view.on('sell:qty', v => { this.sellQty = Math.max(1, Math.floor(Number(v)) || 1); save(); this.previewSell(); });
      view.on('sell:refresh', () => { this.sellTries = 0; this.loadSell(); });
      view.on('tab', name => { if (name === 'kit' && !this.sellBusy) this.loadSell(); });
      view.on('sell:go', async () => {
        if (this.sellBusy) { sell.stop(); view.setSellStatus('Đang dừng sau lệnh hiện tại...'); return; }
        const x = this.sellList.find(i => i.key === this.sellSel);
        if (!x) { this.uiLog('Bán đồ: chưa chọn vật phẩm.'); return; }
        const m = SellCatalog.clamp(x, this.sellQty); this.sellQty = m; view.setSellQty(m); save();
        const msg = `Bán ${m.toLocaleString('en-US')} × ${x.name} (ước tính ${SellCatalog.estimate(x, m).toLocaleString('en-US')} linh thạch)?\nKhông hoàn tác được.${SellCatalog.isHigh(x) ? `\n⚠ Độ hiếm cao (${x.rarity}).` : ''}`;
        if (!view.confirm(msg)) { this.uiLog('Đã hủy bán đồ.'); return; }
        this.sellBusy = true; view.setSellBusy(true);
        try { await sell.run(this.sellSel, m); }
        catch (e) { this.uiLog(`Bán đồ: ${e.message}`); }
        finally { this.sellBusy = false; view.setSellBusy(false); }
      });
    }
    previewSell() {
      const x = this.sellList.find(i => i.key === this.sellSel);
      if (!x) { this.view.setSellPreview(''); return; }
      const m = SellCatalog.clamp(x, this.sellQty);
      this.view.setSellPreview(`${m.toLocaleString('en-US')} cái, ước tính ${SellCatalog.estimate(x, m).toLocaleString('en-US')} linh thạch${m < this.sellQty ? ` (tối đa ${x.quantity.toLocaleString('en-US')})` : ''}`);
    }
    showSell(inv) {
      const list = this.sellList = SellCatalog.items(inv);
      if (!list.some(x => x.key === this.sellSel)) this.sellSel = list.length ? list[0].key : null;
      this.view.setSellItems(list, this.sellSel);
      this.previewSell();
    }
    async loadSell() {
      clearTimeout(this.sellTimer);
      try { this.showSell(await this.api.getInventory()); this.sellTries = 0; }
      catch (_) { if (++this.sellTries <= 10) this.sellTimer = setTimeout(() => this.loadSell(), 3000); }
    }
    showChest(inv) {
      const list = BulkUseCatalog.boxes(inv);
      if (!list.some(it => BulkUseCatalog.key(it) === this.chestSel)) this.chestSel = list.length ? BulkUseCatalog.key(list[0]) : null;
      this.view.setChestItems(list, this.chestSel);
    }
    async loadChest() {
      clearTimeout(this.chestTimer);
      try { this.showChest(await this.api.getInventory()); this.chestTries = 0; }
      catch (_) { if (++this.chestTries <= 10) this.chestTimer = setTimeout(() => this.loadChest(), 3000); }
    }

    async loadBeastInfo() {
      clearTimeout(this.beastTimer);
      try { await this.beast.snapshot(); this.beastTries = 0; }
      catch (_) { if (++this.beastTries <= 10) this.beastTimer = setTimeout(() => this.loadBeastInfo(), 3000); }
    }

    async loadSeeds() {
      const { api, view, garden, storage } = this;
      clearTimeout(this.seedTimer);
      try {
        const state = await api.getGardenState();
        const list = GardenCatalog.seeds(state);
        if (!list.length) throw new Error('chưa có hạt giống nào dùng được');
        const saved = storage.getJSON('tt-auto-boss-garden-seed', null);
        const keepId = [garden.st.seedId, saved].find(id => id != null && list.some(x => x.id === id));
        const sel = list.find(x => x.id === keepId) || list.find(x => x.name === CFG.GARDEN_DEFAULT_SEED) || list[0];
        this.seedList = list;
        view.setSeeds(list, sel.id);
        garden.st.seedId = sel.id;
        this.seedTries = 0;
        this.uiLog(`Đã tải ${list.length} loại hạt giống. Đang chọn: ${GardenCatalog.label(sel)}`);
        this.refreshStonesHint();
      } catch (e) {
        if (++this.seedTries <= 30) this.seedTimer = setTimeout(() => this.loadSeeds(), 3000);
        else this.uiLog(`Không tải được danh sách hạt giống: ${e.message}. Bấm ↻ để thử lại.`);
      }
    }

    // khi chưa chạy: hiện số linh thạch hiện có và giá hạt đang chọn
    async refreshStonesHint() {
      const { api, view, garden } = this;
      if (garden.st.running) return;
      try {
        const me = await api.getMe(); const seed = (this.seedList || []).find(x => x.id === garden.st.seedId);
        if (me && typeof me.spirit_stones === 'number' && seed) {
          const ok = me.spirit_stones >= seed.price;
          view.setGardenStones(ok ? `Linh thạch: ${me.spirit_stones.toLocaleString()} (hạt ${seed.price.toLocaleString()}/ô)` : `⚠ Không đủ linh thạch: có ${me.spirit_stones.toLocaleString()}, 1 ô cần ${seed.price.toLocaleString()}`, ok ? null : false);
        }
      } catch (_) {}
    }

    // luyện đan: droplist loại đan + nút bật/tắt
    bindAlchemy() {
      const { view, alchemy, storage } = this;
      const KEY = 'tt-auto-boss-alchemy-recipe';
      const BK = 'tt-auto-boss-alchemy-bulk', st = alchemy.st;
      const sv = storage.getJSON(BK, null) || {};
      if (Array.isArray(sv.extras)) st.bulkExtras = [...new Set(sv.extras.filter(Number.isFinite))];
      if (sv.on && typeof sv.on === 'object') for (const k of Object.keys(sv.on)) if (sv.on[k] === true) st.bulkOn[k] = true;
      this.syncBulk = (saveIt = true) => {
        st.bulkExtras = st.bulkExtras.filter(id => id !== st.recipeId); // loại đã là loại chính thì bỏ khỏi danh sách thêm
        st.bulkVer++;
        if (saveIt) storage.setJSON(BK, { extras: st.bulkExtras, on: st.bulkOn });
        view.setBulk(st.bulkExtras, st.bulkOn);
      };
      view.on('alchemy:recipe', id => { st.recipeId = id; storage.setJSON(KEY, id); this.syncBulk(); }); // đang chạy thì engine tự nhận lựa chọn mới
      view.on('bulk:main', on => { if (st.recipeId == null) return; if (on) st.bulkOn[st.recipeId] = true; else delete st.bulkOn[st.recipeId]; this.syncBulk(); this.uiLog(`Luyện đủ 50 lượt (loại chính): ${on ? 'BẬT' : 'TẮT'}.`); });
      view.on('bulk:toggle', (id, on) => { if (on) st.bulkOn[id] = true; else delete st.bulkOn[id]; this.syncBulk(); });
      view.on('bulk:remove', id => { st.bulkExtras = st.bulkExtras.filter(x => x !== id); delete st.bulkOn[id]; this.syncBulk(); });
      view.on('bulk:set', (oldId, newId) => {
        if (!newId || st.bulkExtras.includes(newId) || newId === st.recipeId) { this.syncBulk(false); return; }
        st.bulkExtras = st.bulkExtras.map(x => (x === oldId ? newId : x));
        if (st.bulkOn[oldId]) st.bulkOn[newId] = true; delete st.bulkOn[oldId]; this.syncBulk();
      });
      view.on('bulk:add', () => {
        const free = (this.recipeList || []).find(r => r.id !== st.recipeId && !st.bulkExtras.includes(r.id));
        if (!free) { this.uiLog('Không còn loại đan nào để thêm.'); return; }
        st.bulkExtras.push(free.id); st.bulkOn[free.id] = true; this.syncBulk();
      });
      view.on('alchemy:refresh', () => { this.recipeTries = 0; this.loadRecipes(); });
      this.bindToggle('alchemy', alchemy);
    }

    async loadRecipes() {
      const { api, view, alchemy, storage } = this;
      clearTimeout(this.recipeTimer);
      try {
        const state = await api.getAlchemyState();
        const list = AlchemyCatalog.craftable(state && state.recipes);
        if (!list.length) throw new Error('chưa có đan phương nào dùng được');
        const saved = storage.getJSON('tt-auto-boss-alchemy-recipe', null);
        const keepId = [alchemy.st.recipeId, saved].find(id => id != null && list.some(r => r.id === id));
        // ưu tiên lựa chọn đã lưu / đang chọn; chưa có thì mặc định là CFG.ALCHEMY_DEFAULT_PILL; không có nữa thì loại đầu danh sách
        const sel = list.find(r => r.id === keepId) || list.find(r => r.result_name === CFG.ALCHEMY_DEFAULT_PILL) || list[0];
        this.recipeList = list;
        view.setRecipes(list, sel.id);
        alchemy.st.recipeId = sel.id;
        alchemy.st.bulkExtras = alchemy.st.bulkExtras.filter(id => list.some(r => r.id === id)); // bỏ loại không còn dùng được
        this.syncBulk();
        this.recipeTries = 0;
        this.uiLog(`Đã tải ${list.length} đan phương. Đang chọn: ${AlchemyCatalog.label(sel)}`);
      } catch (e) {
        // thường là chưa bắt được token đăng nhập của game: thử lại vài lần
        if (++this.recipeTries <= 30) this.recipeTimer = setTimeout(() => this.loadRecipes(), 3000);
        else this.uiLog(`Không tải được danh sách đan phương: ${e.message}. Bấm ↻ để thử lại.`);
      }
    }

    // Nạp / lưu / nối sự kiện cho ô tích + thanh trượt đôi x% – y% của từng chế độ (p = hp | mp | mg | hg, khớp DUAL_SPECS).
    // modes = { chế độ: { enabled, [px], [py] } }; [px, py] = tên hai thuộc tính trong modes; [fx, fy] = tên hai trường khi lưu; sv = dữ liệu đã lưu hoặc null; defOn = bật mặc định
    bindDual(p, modes, [px, py], [fx, fy], KEY, sv, defOn, what) {
      const { view, storage } = this, ev = DUAL_SPECS.find(x => x.p === p).ev;
      const NAME = { boss: 'boss', hunt: 'săn yêu', farm: 'tầm bảo', um: 'U Minh Cốc', tower: 'leo tháp' };
      const five = v => Number.isInteger(v) && v % 5 === 0 && v >= 5 && v <= 95, pc = v => Math.round(v * 100);
      for (const k of Object.keys(modes)) {
        const m = modes[k], o = (sv || {})[k] || {};
        m.enabled = o.enabled === undefined ? defOn : !!o.enabled;
        const lo = o[fx] === undefined ? pc(m[px]) : o[fx], hi = o[fy] === undefined ? pc(m[py]) : o[fy];
        if (five(lo) && five(hi) && lo < hi) { m[px] = lo / 100; m[py] = hi / 100; }
        view.setDual(`${p}-${k}`, m.enabled, pc(m[px]), pc(m[py]));
      }
      const save = () => storage.setJSON(KEY, Object.fromEntries(Object.entries(modes).map(([k, m]) => [k, { enabled: m.enabled, [fx]: pc(m[px]), [fy]: pc(m[py]) }])));
      save();
      view.on(`${ev}:toggle`, (k, on) => { modes[k].enabled = on; save(); this.uiLog(`${on ? 'Bật' : 'Tắt'} ${what} (${NAME[k]}).`); });
      view.on(`${ev}:range`, (k, lo, hi) => { modes[k][px] = lo / 100; modes[k][py] = hi / 100; save(); });
    }

    // ngưỡng MP và ngưỡng HP của từng chế độ (tầm bảo, săn yêu, leo tháp, U Minh Cốc) + nút "Hồi MP ngay" (đan hồi MP theo từng chế độ nằm ở bindPills)
    bindMp() {
      const { view, storage } = this;
      // mỗi chế độ một ngưỡng MP và một ngưỡng HP, mỗi ngưỡng có ô bật / tắt riêng (mặc định BẬT), nhớ sau khi tải lại trang.
      // Bản cũ chỉ có 1 ngưỡng chung (tt-auto-boss-gate / -gate-on, tt-auto-boss-hgate / -hgate-on): chép sang mọi chế độ khi chưa có cấu hình mới.
      const ok5 = v => Number.isInteger(v) && v % 5 === 0 && v >= 5 && v <= 95;
      const gateSv = (cfg, KEY, OLD_ON, OLD_RANGE) => {
        const sv = storage.getJSON(KEY, null);
        if (sv) return sv;
        const on = storage.getRaw(OLD_ON) !== '0', old = storage.getJSON(OLD_RANGE, null) || {}, good = ok5(old.lo) && ok5(old.hi) && old.lo < old.hi;
        return Object.fromEntries(Object.keys(cfg.modes).map(k => [k, { enabled: on, lo: good ? old.lo : undefined, hi: good ? old.hi : undefined }]));
      };
      const mg = this.shared.mpGate, hg = this.shared.hpGate;
      this.bindDual('mg', mg.modes, ['pause', 'resume'], ['lo', 'hi'], 'tt-auto-boss-mp-gate', gateSv(mg, 'tt-auto-boss-mp-gate', 'tt-auto-boss-gate-on', 'tt-auto-boss-gate'), true, 'ngưỡng MP');
      this.bindDual('hg', hg.modes, ['pause', 'resume'], ['lo', 'hi'], 'tt-auto-boss-hp-gate', gateSv(hg, 'tt-auto-boss-hp-gate', 'tt-auto-boss-hgate-on', 'tt-auto-boss-hgate'), true, 'ngưỡng HP');
      // nút "Hồi MP ngay": dùng đan tới mức của thanh "Hồi ngay" (dùng chung với Hồi HP ngay), không cần đang có trận chiến
      view.on('pill:refill', async () => {
        view.setPillNowBusy(true);
        try { await this.pillTool.refill(this.hpNowTarget); } finally { view.setPillNowBusy(false); }
      });
    }

    bindBreakthrough() {
      const { view, bt, storage } = this;
      const BT_KEY = 'tt-auto-boss-bt';
      bt.on('stop', () => { view.setBtChecked(false); this.mem.onSelfStop('bt', this.authLost()); if (!this.mem.wants('bt')) storage.setRaw(BT_KEY, '0'); this.showMem(); });
      view.on('bt:toggle', checked => {
        storage.setRaw(BT_KEY, checked ? '1' : '0'); this.mem.set('bt', checked); this.showMem();
        if (checked) bt.run(); else if (bt.st.running) bt.stop();
      });
      // đan tăng tỉ lệ đột phá: ô tích + droplist (mặc định đan mạnh nhất), nhớ lựa chọn; công pháp cũ chưa đổi lại được thì nhớ để đổi lại
      const PILL_KEY = 'tt-auto-boss-bt-pill', TECH_KEY = 'tt-auto-boss-bt-tech';
      const sv = storage.getJSON(PILL_KEY, null) || {};
      bt.st.pillOn = !!sv.on; bt.st.pillId = sv.id == null ? null : sv.id; view.setBtPillOn(bt.st.pillOn);
      const savePill = () => storage.setJSON(PILL_KEY, { on: bt.st.pillOn, id: bt.st.pillId });
      view.on('bt:pillon', on => { bt.st.pillOn = !!on; savePill(); });
      view.on('bt:pill', key => { bt.st.pillId = key; savePill(); });
      view.on('bt:pillrefresh', () => { this.btTries = 0; this.loadBtPills(); });
      view.on('tab', name => { if (name === 'grow') this.loadBtPills(); });
      bt.on('attempt', () => this.loadBtPills());
      bt.on('techpending', id => storage.setRaw(TECH_KEY, id || ''));
      const pend = storage.getRaw(TECH_KEY);
      if (pend) { bt.st.pendingTech = pend; this.restoreBtTech(); }
    }
    showBtPills(inv) {
      const { bt, view } = this; const list = BreakthroughCatalog.pills(inv);
      if (!list.some(it => BreakthroughCatalog.key(it) === bt.st.pillId)) bt.st.pillId = list.length ? BreakthroughCatalog.key(list[0]) : null; // mặc định: đan mạnh nhất
      view.setBtPills(list, bt.st.pillId);
    }
    async loadBtPills() {
      clearTimeout(this.btTimer);
      try { this.showBtPills(await this.api.getInventory()); this.btTries = 0; }
      catch (_) { if ((this.btTries = (this.btTries || 0) + 1) <= 10) this.btTimer = setTimeout(() => this.loadBtPills(), 3000); }
    }
    // tải lại trang khi đang đổi công pháp giữa chừng: đổi lại công pháp cũ ngay khi gọi được API
    async restoreBtTech() {
      try { await this.bt.restoreTechnique(); }
      catch (_) {}
      if (this.bt.st.pendingTech && (this.btTechTries = (this.btTechTries || 0) + 1) <= 10) setTimeout(() => this.restoreBtTech(), 3000);
    }

  }

  /* ===================== KHỞI ĐỘNG ===================== */
  const api = new GameApi().install(); // phải móc fetch/XHR ngay từ document-start để bắt token
  const startApp = () => new App(api).start();
  if (document.body) startApp(); else document.addEventListener('DOMContentLoaded', startApp);
})();