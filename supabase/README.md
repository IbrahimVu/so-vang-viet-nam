# Lịch quét giá trên Supabase Free

1. Dùng một dự án Supabase Free riêng cho Sổ Vàng. Giữ Data API bật và chỉ mở các hàm đọc bảng giá, yêu cầu làm mới trong migration. Áp dụng migration trong `supabase/migrations`.
2. Chạy `node build-supabase.mjs` để tạo `supabase/functions/gold-scan/index.ts` rồi triển khai hàm `gold-scan` từ tệp này. Hàm xác thực bằng khóa lịch quét riêng và mã dùng một lần.
3. Tạo khóa ngẫu nhiên ít nhất 32 byte. Lưu cùng giá trị dưới tên `GOLD_SCAN_SECRET` trong Edge Functions Secrets và `gold_scan_secret` trong Vault. Tạo mục `gold_scan_url` trong Vault có giá trị là URL HTTPS của hàm đã triển khai. Nếu bật kiểm tra JWT ở gateway, lưu khóa JWT công khai cũ của vai trò `anon` dưới tên `gold_scan_gateway_jwt` trong Vault. Tạo các mục trong giao diện quản trị, giữ khóa ngoài mã nguồn, lịch sử SQL và GitHub.
4. Gọi `gold_refresh` bằng Publishable key, đợi `gold_prices` trả về dữ liệu rồi kiểm tra từng nguồn. Xác nhận hàm quét trả về HTTP 401 khi thiếu khóa và vai trò công khai không gọi được `gold_publish` hay `gold_scan_context`. Xác minh SJC và BTMC trước khi chuyển nguồn.
5. Chạy `supabase/schedule.sql` và xác nhận ít nhất một lần chạy từ Cron đã cập nhật `gold_prices`. Kiểm tra cả `cron.job_run_details` và kết quả HTTP trong `net._http_response` vì Cron chỉ ghi kết quả đưa yêu cầu vào hàng đợi.
6. Đặt hai biến GitHub Actions `GOLD_SUPABASE_REF` và `GOLD_SUPABASE_PUBLISHABLE_KEY`. Chạy workflow Pages trên `main`, kiểm tra bảng giá và nút Làm mới trên website. Biến `PRICE_SNAPSHOT_URL` cần để trống khi dùng Supabase.

Lịch chạy 145 lượt mỗi ngày vào các mốc 5 phút từ 08:30 đến hết 20:30 giờ Việt Nam. Làm mới theo yêu cầu dùng giới hạn chung 100 lượt/ngày theo giờ Việt Nam, tối đa một lượt mỗi phút. Nếu một lượt quét theo yêu cầu vừa chạy, lịch có thể dùng kết quả của lượt đó. Khi toàn bộ nguồn lỗi, lượt quét trả về lỗi và bảng giá hợp lệ gần nhất vẫn đọc được.

Để quay về lịch GitHub, xóa cả hai biến Supabase và chạy lại workflow Pages. Có thể tắt ba job `gold-scan-morning`, `gold-scan-day` và `gold-scan-evening` trong Supabase Cron sau khi đã xác nhận trang quay về nguồn cũ.
