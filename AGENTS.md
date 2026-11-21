# Sổ Vàng Việt Nam

Sau mỗi lần sửa website theo yêu cầu, hoàn tất quy trình xuất bản trong cùng lượt làm việc, trừ khi người dùng yêu cầu chỉ sửa cục bộ.

1. Kiểm tra thay đổi và chạy `node build-pages.mjs` để xác nhận giao diện cùng dữ liệu giá xuất được cho GitHub Pages.
2. Đưa đúng các thay đổi đã kiểm tra lên nhánh `main` của `IbrahimVu/so-vang-viet-nam`. Giữ nguyên các thay đổi khác trong kho và dùng cập nhật fast-forward.
3. Theo dõi GitHub Actions của commit vừa xuất bản. Chờ cả bước build và deploy thành công, rồi kiểm tra [trang công khai](https://ibrahimvu.github.io/so-vang-viet-nam/) và dữ liệu liên quan đến thay đổi.
4. Báo kết quả ngay trong cuộc trò chuyện sau khi kiểm tra. Nêu ngắn gọn nội dung thay đổi, kèm liên kết trang và lần chạy GitHub Actions. Nếu triển khai lỗi, xử lý lỗi trong phạm vi được yêu cầu. Báo cụ thể nếu còn vướng mắc.

Chỉ xuất bản mã nguồn và dữ liệu niêm yết công khai. Giữ thông tin xác thực và cấu hình ChatGPT Sites riêng tư ngoài kho GitHub. Các lần làm mới giá theo lịch GitHub Actions được xử lý bởi workflow hiện có.
