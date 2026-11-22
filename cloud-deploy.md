# Triển khai lịch quét Sổ Vàng trên Google Cloud

Dùng một project Google Cloud đã bật Billing và tài khoản có quyền triển khai Cloud Run từ mã nguồn, bật API và cấp IAM cho các tài nguyên Sổ Vàng. Đăng nhập bằng `gcloud auth login` trong trình duyệt Google. Cloud Scheduler gọi Cloud Run nội bộ bằng OIDC và dịch vụ dùng tài khoản dịch vụ để ghi tệp giá.

## Chạy thử song song

1. Chạy `./cloud-deploy.ps1 -ProjectId PROJECT_ID` từ kho mã. Vùng mặc định là Singapore. Cấp vai trò Cloud Run Builder cho tài khoản Cloud Build của project nếu Cloud Build báo thiếu quyền.
2. Kiểm tra Cloud Scheduler và nhật ký Cloud Run trong giờ Việt Nam. Để thử ngay trong giờ quét, chạy `gcloud scheduler jobs run so-vang-scan --location=asia-southeast1 --project=PROJECT_ID`. Xác nhận các mốc liên tiếp ghi `published` và `gs://PROJECT_ID-so-vang-quotes/prices.json` có `checkedAt` tăng dần. Kiểm tra riêng SJC và BTMC. Nếu mọi nguồn lỗi, dịch vụ giữ tệp cũ và trả 503 để thử lại.
3. Tạo cảnh báo dựa trên nhật ký với bộ lọc dưới đây. Chọn và kiểm tra kênh nhận thông báo trong Cloud Monitoring. Kiểm tra sức khỏe bắt đầu từ 08:40. Cảnh báo có thể phát khi chưa lấy được giá thành công trong 10 phút.

   ```text
   resource.type="cloud_run_revision"
   resource.labels.service_name="so-vang-scan"
   jsonPayload.event="gold-price-health"
   (jsonPayload.result="stale" OR jsonPayload.result="failed")
   ```

## Chuyển nguồn cho GitHub Pages

1. Sau khi xác minh lịch quét cloud, kiểm tra bucket chuyên dụng chỉ có `prices.json`. Cấu hình CORS và quyền công khai chỉ đọc.

   ```powershell
   gcloud storage buckets update gs://PROJECT_ID-so-vang-quotes --cors-file=cloud-storage-cors.json --project=PROJECT_ID
   gcloud storage buckets add-iam-policy-binding gs://PROJECT_ID-so-vang-quotes --member=allUsers --role=roles/storage.legacyObjectReader --project=PROJECT_ID
   ```

2. Kiểm tra `https://storage.googleapis.com/PROJECT_ID-so-vang-quotes/prices.json` khi chưa đăng nhập. Xác minh yêu cầu từ origin `https://ibrahimvu.github.io` nhận được CORS phù hợp.
3. Đặt biến GitHub Actions `PRICE_SNAPSHOT_URL` bằng URL tệp đã xác minh và chạy workflow Pages từ `main`. Trang đọc tệp trực tiếp và giữ một bản đóng gói để dự phòng. Lịch GitHub bỏ qua bước quét khi biến được đặt.
4. Xác nhận website nhận được hai mốc giá liên tiếp mà không có bản triển khai Pages xen giữa. Để quay lại nguồn trước, xóa biến và chạy lại workflow Pages từ `main`.
