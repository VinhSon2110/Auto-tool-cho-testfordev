# Auto-tool-cho-testfordev.online
KIẾN TRÚC (cập nhật tới v2.45.2). Thứ tự trong file đi từ lớp thuần tới lớp phụ thuộc DOM / mạng:
 
   1. Domain (thuần, không side-effect)  : ElementRules, SkillSelector, CombatFormatter, BossCatalog (chọn boss + chế độ nâng cao theo cỡ boss: full / min70 / dmg50 / dmg25), MonsterCatalog, PillCatalog, AlchemyCatalog,
                                           SkillCatalog (sách chiêu; đọc định dạng mới skill_id + effects[] và suy ra skill_kind / mp_cost / hệ cho phần còn lại),
                                           GardenCatalog, UMinhPlanner (tìm bước đi U Minh Cốc)
   2. Hạ tầng                            : EventEmitter, StateMachine, RateLimiter, Coordinator (cờ ưu tiên + skillGate), PillBook (đan đang chọn + tồn kho),
                                           cấu hình theo từng chế độ (đọc trực tiếp, UI sửa tại chỗ): HpPillConfig (đan hồi HP), MpPillConfig (đan hồi MP),
                                           HealSkillConfig (mức dùng chiêu hồi máu), MpGate / HpGate (ngưỡng tạm dừng / chạy tiếp của tầm bảo, săn yêu, leo tháp, U Minh Cốc);
                                           PillConfig (cấu hình dự phòng cho nút "Hồi MP ngay"),
                                           RequestQueue (hàng chờ lệnh gọi game: hai lệnh cách nhau >= REQ_GAP_MS (~1s), 3 mức ưu tiên + nâng mức khi chờ lâu, gộp GET trùng, dừng khi server báo gọi quá nhiều)
   3. Dịch vụ dùng chung                 : Healer (dưỡng thương), PillManager (đan hồi MP theo chế độ + nút Hồi MP ngay), HpPillService (đan hồi HP theo chế độ + nút Hồi HP ngay),
                                           SkillSwapper (tự đổi chiêu khắc hệ, chỉ trước boss)
   4. Engine (mỗi chế độ = 1 class)      : Engine (abstract)
                                             ├─ BossEngine, BreakthroughEngine, AlchemyEngine, BeastEngine, GardenEngine, XuatHonEngine, WarEngine (Tông Chiến, vòng lặp thường, không dùng MatchEngine)
                                             └─ MatchEngine (khung trận đánh dùng chung: waitGate = ngưỡng HP / MP trước khi mở trận hoặc vào U Minh, waitMp = hết MP giữa trận)
                                                → FarmEngine (tầm bảo), HuntEngine (săn yêu), TowerEngine (leo tháp), UMinhEngine (U Minh Cốc)
        Đi kèm trong phần này: WarCatalog (chọn lãnh địa, lọc mục tiêu, mốc xx:25 và 20:55), BreakthroughCatalog, BeastCatalog, XuatHonCatalog, AutoLogin, ModeMemory (nhớ chế độ để tự bật lại), BulkUseCatalog / BulkUseEngine (mở nhiều), SellCatalog / SellEngine (bán đồ)
        - Engine KHÔNG đụng DOM: chỉ phát sự kiện 'log' | 'start' | 'stop' | 'state' | 'status' | 'tickets' (và vài sự kiện riêng của từng chế độ)
        - Vòng lặp chính và vòng lặp trận đánh là các StateMachine (bảng chuyển trạng thái khai báo rõ ràng, vd. XuatHonEngine.TRANSITIONS)
        - Mọi lỗi đều không tự tắt chế độ: chờ lùi 10 / 20 / 30s rồi 120s (boss cố định 2s, đột phá cố định 5s)
   5. Hạ tầng mạng                       : GameApi (bắt token bằng hook fetch / XHR, gọi REST; MỌI lệnh đi qua RequestQueue, mức ưu tiên chọn theo đường dẫn;
                                           mỗi lệnh có giới hạn HTTP_TIMEOUT_MS, quá hạn thì thành lỗi để cơ chế lùi / watchdog xử lý, không để chế độ đứng im)
   6. UI                                 : PanelView (DOM thuần, phát sự kiện ý định của người dùng), DualSlider (thanh trượt đôi), SingleSlider (thanh đơn "Hồi ngay"), SafeStorage
        - Hai giao diện dùng chung một bộ phần tử và id: giao diện máy tính (bảng nổi, kéo được) và giao diện màn hình nhỏ cảm ứng
          (class "cp": ngăn kéo bên phải + thanh thu gọn + thẻ chế độ + trang cài đặt riêng; dải trạng thái hiện mỗi chế độ đang chạy thành một nút, chạm để tắt; ngưỡng HP / MP của từng chế độ nằm trong mục gập "Ngưỡng HP / MP · hồi máu"; vùng chạm tối thiểu 44px). Tự chọn theo độ rộng màn (<= 1100px), nút ở thanh tiêu đề để đổi tay
        - Bốn bộ "ô tích + thanh trượt đôi x% – y%" theo từng chế độ (đan hồi HP, đan hồi MP, ngưỡng MP, ngưỡng HP) khai báo trong DUAL_SPECS,
          dựng HTML, nối sự kiện (<ev>:toggle, <ev>:range) và đặt giá trị bằng cùng một mã (dual / showDual / setDual)
        - Tab Hành trang, mục "Đan": chọn loại đan HP / MP, thanh "Hồi ngay" dùng chung cho nút "Hồi MP ngay" và "Hồi HP ngay"
   7. App (controller)                   : nối engine <-> view bằng sự kiện (các hàm bind*; bindDual nạp / lưu / nối sự kiện cho 4 bộ trên, có chuyển dữ liệu cũ),
                                           lệnh đổi chiêu chờ (queueSkill / flushSkillQueue), điều kiện chạy của xuất hồn (xhBlockers)
 
   THỨ TỰ ƯU TIÊN (Coordinator): đột phá > boss > U Minh Cốc > săn yêu > leo tháp > tầm bảo > xuất hồn.
   - Boss chiếm 3 phút đầu mỗi giờ; đột phá chen vào giữa các trận (btPause) và có thể đợi trận đang dở.
   - Còn boss và đang bật chế độ boss (coord.bossPending): U Minh Cốc không vào và không mở lượt mới, vì trong U Minh HP, MP không tự hồi theo thời gian (đan vẫn dùng được).
   - Chế độ nâng cao của từng cỡ boss (BossEngine.st.modes, lưu localStorage, mặc định full = đánh tới cùng):
       min70 = chỉ đánh khi boss còn >= 70% HP: xét cả lúc vào lẫn trước mỗi đòn (sCheck), tụt dưới 70% là dừng ngay kể cả đang đánh, không phụ thuộc F5;
       dmg50 / dmg25 = sát thương của bạn (myDamage) đạt 50% / 25% hp_max thì tạm dừng (st.paused), nhả coord.boss cho các chế độ khác,
       quét boss chờ còn <= BossCatalog.LAST_HIT (2,5% HP) rồi đánh tiếp để giành last hit. Chờ tối đa BOSS_LASTHIT_WAIT_MS thì bỏ boss đó (st.gaveUp).
       Lúc chờ, coord.bossPending vẫn bật nên U Minh Cốc không vào; các chế độ khác chạy. Tần suất quét: trên 30% HP mỗi 10s, 10-30% mỗi 3s, dưới 10% mỗi 2s.
       Đang đánh boss khác mà boss chờ last hit tới mốc thì sCheck (3s một lần) nhường và pick chọn boss đó trước.
   - U Minh Cốc, tầm bảo, xuất hồn không chạy song song nhau (quy tắc game). Xuất hồn chỉ bắt đầu khi U Minh Cốc đã đi xong (hoặc tắt) và tầm bảo hết vé (hoặc tắt);
     xuất hồn đang chạy dở mà U Minh Cốc / tầm bảo cần vào thì BỎ lượt đó (abandon, mất thưởng). Xuất hồn không đụng tới boss / săn yêu / leo tháp.
   - Ngưỡng HP / MP (mỗi chế độ, mỗi ngưỡng một ô bật / tắt): HP hoặc MP <= mức tạm dừng thì không mở trận mới (U Minh Cốc: không vào); dùng đan của chế độ đó
     (nếu bật) tới ít nhất mức chạy tiếp, không có đan thì chờ tự hồi, kiểm tra lại mỗi 2 phút, chạy tiếp khi vượt mức chạy tiếp. Boss không có ngưỡng này.
   - Đổi chiêu: lệnh bị hoãn khi đang trong trận; các chế độ gọi coord.skillGate() giữa hai trận để đổi ngay trước khi mở trận mới.
   - Tự đổi chiêu khắc hệ (SkillSwapper + SkillCatalog.plan) chỉ chạy trước boss: bộ chiêu đang gắn đã có chiêu công kích khắc thì giữ nguyên; nếu chưa có thì mới tìm
     trong chiêu dự bị (ô "Chiêu dùng để thay"), trống thì không tìm. Đổi tối thiểu (còn ô trống chỉ gắn thêm, hết ô thì tháo 1 chiêu yếu nhất rồi gắn);
     gắn lỗi sau khi đã tháo thì gắn lại chiêu vừa tháo. Leo tháp không đổi chiêu.
   - Tông Chiến (WarEngine, chỉ chạy khi bật; trận mô phỏng nên không đụng HP thật, không xung đột với các chế độ khác): trước gatherAt chờ; từ gatherAt đổi chiêu một lần
     (SkillSwapper.ensureWar + SkillCatalog.planWar: 1 chiêu hồi máu mạnh nhất + các chiêu công kích mạnh nhất, vì server chụp bộ chiêu lúc POST garrison và khóa tới hết sự kiện,
     đổi giữa trận vô ích) rồi vào lãnh địa; trong khung liveStartAt - liveEndAt mỗi lượt: người chơi khác tông có power <= CFG.WAR_MAX_POWER (không giới hạn lượt, yếu nhất trước)
     > thủ vệ (guard.remaining > 0, tối đa 5 lần thắng) > chờ người chơi xuất hiện. Một lượt = POST attack mở trận + POST match/action lặp tới finished. Chờ nextActionAt / woundedUntil
     giữa các lượt; dừng khi hết giờ live hoặc attacksMade >= limits.maxAttacks. Lãnh địa: chỉ liệt kê lãnh địa tông đã đăng ký, mặc định vòng cao trước (center > middle > outer),
     quét khi bật và mỗi xx:25; lựa chọn tay được giữ tới 20:55 rồi về mặc định (lưu localStorage). Đã garrison thì lãnh địa lấy từ me.garrison.
   - Hàng chờ lệnh (RequestQueue): ưu tiên 0 = boss, đột phá, đổi chiêu; 1 = tầm bảo, săn yêu, leo tháp, U Minh Cốc, Tông Chiến, thông tin nhân vật; 2 = việc nền (bán đồ, mở rương, ấp trứng...).
 *    Lệnh chờ quá REQ_AGING_MS thì được nâng một mức. Gặp 429 / "too many requests": dừng hàng REQ_PAUSE_MS rồi gửi lại đúng 1 lần.
