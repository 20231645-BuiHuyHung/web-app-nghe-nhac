# Nhạc Online – Đồ án chuyên ngành CNPM (Mã đề 6)

Web nghe nhạc trực tuyến: Node.js (Express) + Vanilla JS + TailwindCSS. Dữ liệu được lưu trong SQLite tại `data/music.sqlite` bằng `sql.js` (WebAssembly), không cần cài dịch vụ database hay bộ công cụ C++.

## Chạy dự án

Yêu cầu Node.js >= 18 và có internet (Tailwind CDN, ảnh bìa, nhạc mẫu từ SoundHelix).

```bash
npm install
npm start
# mở http://localhost:3000
```

Chạy bộ kiểm thử luồng yêu cầu VIP (dùng server và SQLite tạm, không sửa database thật):

```bash
npm test
```

Lần chạy đầu tiên sau nâng cấp, server tự nhập dữ liệu hiện có từ `data/db.json` vào `data/music.sqlite`. File JSON ban đầu được giữ nguyên làm bản sao; các thay đổi mới chỉ được lưu vào SQLite. Nếu chưa có file JSON cũ, dữ liệu mẫu được nhập từ `data/seed.json`.

Để sao lưu dữ liệu, hãy dừng server rồi sao chép `data/music.sqlite` sang nơi an toàn. Không xóa database để reset nếu bạn cần giữ tài khoản, bài hát hoặc playlist.

## Cấu trúc

```
server.js          Backend Express: REST API, SQLite, streaming, upload
data/music.sqlite  SQLite database (tự tạo và nhập dữ liệu lần đầu)
data/db.json       Dữ liệu JSON cũ giữ làm bản sao sau khi chuyển đổi
data/seed.json     Dữ liệu mẫu (3 nghệ sĩ, 3 album, 8 bài hát mp3 online)
public/index.html  Khung giao diện + thanh phát nhạc cố định
public/style.css   Style bổ sung (thanh trượt, bảng bài hát)
public/app.js      Router SPA, trình phát nhạc, các trang
uploads/           File nhạc và ảnh bìa người dùng tải lên (tự tạo)
public/admin.html  Dashboard quản trị (chỉ tài khoản admin)
public/admin.js    Giao diện và thao tác quản trị
scripts/promote-admin.js  Cấp quyền admin cho tài khoản đã đăng ký
```

## Tài khoản quản trị

1. Đăng ký tài khoản bình thường trên website.
2. Dừng server bằng `Ctrl+C`.
3. Trong thư mục dự án, chạy `npm run make-admin -- email@example.com`.
4. Khởi động lại bằng `npm start`, đăng nhập tài khoản vừa cấp quyền, rồi bấm **Quản trị** hoặc mở `http://localhost:3000/admin.html`.

Lệnh cấp quyền chỉ chạy trên máy chủ và cập nhật tài khoản đã tồn tại; không có mật khẩu admin mặc định. Dừng server trước khi chạy lệnh để tránh ghi đè dữ liệu. Dashboard hỗ trợ quản lý bài hát, album, thể loại, tài khoản User/Admin, khóa tài khoản và thống kê. API quản trị kiểm tra vai trò admin ở server; không chỉ dựa vào việc ẩn giao diện.

Dashboard đồng bộ hội thoại hỗ trợ mỗi 2 giây và các yêu cầu VIP/đặt lại mật khẩu mỗi 4 giây; yêu cầu mới hiện trong bảng và thông báo mà không tải lại trang. Khi người dùng đang đăng nhập, trạng thái tài khoản và yêu cầu VIP được kiểm tra mỗi 5 giây; nếu Admin duyệt khi trang vẫn mở, trang VIP tự cập nhật và thông báo kết quả. Đồng bộ tạm dừng khi tab ở nền để giảm request không cần thiết. Đây là polling nhẹ, không phải cập nhật tức thời qua WebSocket; có thể trễ tối đa khoảng một chu kỳ.

Dashboard có thanh điều hướng để chỉ mở mục quản trị đang chọn, cùng mục **Doanh thu**. Thống kê doanh thu chỉ tính giá của yêu cầu VIP đã được duyệt, theo thời điểm duyệt; các khoảng thời gian là 24 giờ, 7 ngày, 30 ngày, 6 tháng và 12 tháng gần nhất. Chọn một ô doanh thu để lọc danh sách tài khoản, email, gói VIP, giá và ngày duyệt tương ứng; bộ lọc cũng có thể chọn toàn bộ lịch sử. Biểu đồ thể hiện doanh thu theo từng ngày trong 14 ngày gần nhất. Vì thanh toán QR của ứng dụng hiện là mô phỏng và việc nhận tiền được xác nhận bên ngoài hệ thống, đây là doanh thu ghi nhận theo trạng thái duyệt, không phải báo cáo giao dịch tiền thật.

Trong Dashboard, danh sách thể loại, bài hát, album và yêu cầu VIP ban đầu chỉ hiện 5 mục mới nhất. Chọn **Xem thêm** để mở trang tối đa 10 mục; các trang kế tiếp cũng có tối đa 10 mục và có điều hướng trang.

Các thao tác quản trị tạo/sửa/xóa, đổi quyền VIP hoặc trạng thái tài khoản, duyệt/từ chối yêu cầu và thay đổi quyền VIP bài hát đều có bước xác nhận trước khi ghi dữ liệu.

Thông báo thao tác ở trang người nghe và Dashboard Admin được hiển thị dạng thẻ nổi giữa màn hình, tự ẩn sau vài giây. Các thao tác cần xác nhận dùng hộp thoại tùy chỉnh theo giao diện website thay cho hộp thoại mặc định của trình duyệt.

## Khám phá, yêu thích và trình phát

Trang chủ có danh sách bài mới (ưu tiên ID được thêm gần nhất) và bảng xếp hạng 5 bài nghe nhiều nhất. Người dùng đã đăng nhập có thể nhấn biểu tượng trái tim ở danh sách bài hát để lưu/bỏ yêu thích; mục **Yêu thích** hiển thị danh sách riêng của tài khoản. Danh sách yêu thích được lưu trong bảng `favorites` của SQLite.

Trình phát vẫn chạy khi điều hướng giữa các trang SPA. Player có thanh tiến trình tua, chỉnh âm lượng, giao diện kính mờ và visualizer dùng Web Audio API/Canvas. Bài đang phát, hàng đợi, vị trí nghe, chế độ shuffle và repeat được lưu trong `localStorage`, vì vậy sau khi tải lại trang trình phát khôi phục bài và vị trí nhưng để ở trạng thái tạm dừng (trình duyệt thường chặn tự phát sau khi tải lại). Route `/api/stream/:id` hỗ trợ byte range đơn (`206 Partial Content`), suffix range và trả `416` cho byte range không hợp lệ/không hỗ trợ.

Lời đồng bộ được mở bằng nút **Lời bài hát** trên player. Khi sửa lời từ Dashboard, nhập định dạng LRC với mỗi dòng có timestamp, ví dụ `[00:12.50]Dòng lời bắt đầu ở giây 12.5`; nhiều timestamp trên cùng dòng cũng được hỗ trợ. Lời không có timestamp vẫn hiển thị nhưng không tự đồng bộ.

## Xác thực

Đăng nhập sử dụng JWT ký bằng HS256 trong cookie `HttpOnly` và `SameSite=Lax`. Khi chạy local, khóa ký ngẫu nhiên được lưu trong `app_meta` của SQLite để token còn xác minh được sau khi khởi động lại. Khi triển khai, nên đặt biến môi trường `JWT_SECRET` bằng một bí mật mạnh và giữ bí mật đó ngoài mã nguồn/database. Đăng xuất xóa cookie phía trình duyệt; quyền/trạng thái người dùng được tra lại từ SQLite ở mỗi yêu cầu nên tài khoản bị khóa mất quyền truy cập ngay.

Người dùng đã đăng nhập có thể chọn **Đổi mật khẩu**, nhập mật khẩu hiện tại và mật khẩu mới. Mật khẩu hiện tại được xác minh trước khi cập nhật; thao tác sẽ đăng xuất các phiên khác, giữ phiên hiện tại hoạt động và vô hiệu hóa link đặt lại mật khẩu chưa sử dụng.

### Yêu cầu đặt lại mật khẩu

Tại trang đăng nhập, người dùng chọn **Quên mật khẩu?**, nhập email tài khoản và trả lời phép tính xác minh. Yêu cầu chỉ được ghi nhận cho email tài khoản tồn tại; giao diện không tiết lộ email có trong hệ thống hay không. Admin mở mục **Yêu cầu đặt lại mật khẩu** và xác minh danh tính người yêu cầu qua kênh riêng trước khi duyệt. Sau khi duyệt, nếu SMTP được cấu hình link dùng một lần sẽ tự gửi tới email tài khoản; nếu không, Dashboard tạo link để Admin gửi riêng cho người dùng. Link hết hạn sau 30 phút; đặt mật khẩu mới sẽ vô hiệu hóa các phiên đăng nhập cũ. Không gửi link công khai.

CAPTCHA phép tính chạy độc lập, không cần tài khoản dịch vụ bên ngoài; đây là biện pháp cơ bản phù hợp cho đồ án, không thay thế CAPTCHA chuyên dụng hay rate limiting khi triển khai công khai.

Để hệ thống tự gửi link sau khi Admin duyệt, có thể cấu hình SMTP trước khi chạy server:

```powershell
$env:SMTP_HOST = "smtp.example.com"
$env:SMTP_PORT = "587"
$env:SMTP_SECURE = "false"
$env:SMTP_USER = "your-smtp-user"
$env:SMTP_PASS = "your-smtp-password"
$env:SMTP_FROM = "Nhạc Online <no-reply@example.com>"
$env:APP_BASE_URL = "https://your-music-site.example"
npm start
```

`APP_BASE_URL` phải là địa chỉ người dùng mở được; để trống sẽ dùng `http://localhost:3000`. Không lưu thông tin SMTP thật trong mã nguồn. Luồng yêu cầu, CAPTCHA và Admin duyệt vẫn hoạt động độc lập khi SMTP chưa cấu hình. Nếu email gửi thất bại, Admin nhận link để gửi riêng. Nếu người dùng nhập email bịa hoặc không còn truy cập được hộp thư, Admin cần xác minh danh tính trực tiếp trước khi duyệt.
Nếu dùng tunnel Cloudflare, đặt `APP_BASE_URL` bằng URL `https://...trycloudflare.com` hiện tại để liên kết trong email trỏ đúng về ứng dụng. Với Gmail, dùng mật khẩu ứng dụng SMTP thay cho mật khẩu đăng nhập thông thường.

Admin có thể mở **Quản lý tài khoản** trong Dashboard và chọn **Tạo link đặt lại mật khẩu**. Hệ thống sao chép liên kết một lần vào clipboard (hoặc hiển thị để sao chép thủ công); Admin cần gửi riêng liên kết cho đúng người dùng. Không đăng liên kết công khai. Tạo liên kết mới sẽ vô hiệu hóa liên kết đặt lại trước đó của tài khoản.

## API chính

| Method | Đường dẫn | Mô tả |
|---|---|---|
| GET | `/api/admin/revenue` | Admin xem tổng doanh thu và danh sách yêu cầu VIP đã duyệt |
| GET | `/api/auth/password-reset-captcha` | Tạo phép tính CAPTCHA ngắn hạn |
| POST | `/api/auth/password-reset-requests` | Gửi yêu cầu khôi phục sau khi giải CAPTCHA |
| POST | `/api/auth/reset-password` | Đặt mật khẩu mới bằng token dùng một lần |
| GET | `/api/admin/password-reset-requests` | Admin xem yêu cầu khôi phục |
| POST | `/api/admin/password-reset-requests/:id/review` | Admin duyệt/từ chối; khi duyệt gửi email hoặc trả link để gửi riêng |
| POST | `/api/admin/users/:id/password-reset` | Admin chủ động tạo link đặt lại ngoài hàng đợi yêu cầu |
| GET | `/api/songs?q=` | Danh sách / tìm kiếm bài hát |
| GET | `/api/stream/:id` | Stream audio (hỗ trợ HTTP Range) |
| POST | `/api/songs` | Upload bài hát (multipart: `audio`, `cover`, `title`, `artistId` hoặc `artistName`, `albumId`, `genre`) |
| DELETE | `/api/songs/:id` | Xóa bài hát |
| GET | `/api/albums`, `/api/albums/:id` | Album |
| GET | `/api/artists`, `/api/artists/:id` | Nghệ sĩ |
| GET/POST | `/api/playlists` | Danh sách / tạo playlist |
| PUT/DELETE | `/api/playlists/:id` | Đổi tên / xóa playlist |
| POST | `/api/playlists/:id/songs` | Thêm bài (`{ "songId": 1 }`) |
| DELETE | `/api/playlists/:id/songs/:songId` | Bỏ bài khỏi playlist |
| GET | `/api/favorites` | Danh sách yêu thích của tài khoản hiện tại |
| POST/DELETE | `/api/favorites/:songId` | Thêm / bỏ bài khỏi yêu thích |
| POST | `/api/auth/register` | Đăng ký (`{ "name", "email", "password" }`) |
| POST | `/api/auth/login` | Đăng nhập (`{ "email", "password" }`) |
| POST | `/api/auth/logout` | Đăng xuất |
| GET | `/api/auth/me` | Kiểm tra tài khoản đang đăng nhập |
| POST | `/api/auth/change-password` | Đổi mật khẩu của tài khoản đang đăng nhập (`{ "currentPassword", "newPassword" }`) |
| GET/POST | `/api/premium/requests` | Xem lịch sử / gửi yêu cầu nâng cấp VIP chờ Admin duyệt |
| GET | `/api/admin/premium-requests` | Danh sách yêu cầu nâng cấp VIP dành cho Admin |
| POST | `/api/admin/premium-requests/:id/review` | Admin duyệt hoặc từ chối yêu cầu (`{ "action": "approve" | "reject" }`) |
| GET | `/api/support/conversations/current` | Xem phiên chat hỗ trợ hiện tại của tài khoản |
| POST | `/api/support/conversations` | Mở/kết nối phiên chat trực tiếp (cần đăng nhập) |
| GET/POST | `/api/support/conversations/:id/messages` | Xem/gửi tin nhắn trong phiên chat của chính tài khoản |
| GET | `/api/admin/support/conversations` | Danh sách hội thoại đang mở cho Admin |
| GET/POST | `/api/admin/support/conversations/:id/messages` | Admin đọc/trả lời tin nhắn khách hàng |
| POST | `/api/admin/support/conversations/:id/close` | Admin kết thúc phiên hỗ trợ |
| GET | `/api/admin/overview` | Thống kê dành cho admin |
| GET/PATCH | `/api/admin/users[/:id]` | Danh sách và cập nhật quyền/trạng thái tài khoản |
| POST | `/api/admin/users/:id/premium` | Admin cấp thêm 1 tháng hoặc hủy VIP |
| GET/POST/PUT/DELETE | `/api/admin/songs[/:id]` | Quản lý bài hát (admin) |
| PATCH | `/api/admin/songs/:id/vip` | Đánh dấu / bỏ đánh dấu bài hát VIP |
| GET/POST/PUT/DELETE | `/api/admin/albums[/:id]` | Quản lý album (admin) |
| GET/POST/PUT/DELETE | `/api/admin/genres[/:name]` | Quản lý thể loại (admin) |

Mật khẩu được băm trước khi lưu trong SQLite. Playlist, yêu thích và bài hát tải lên được gắn với tài khoản. Nghe nhạc và xem playlist mẫu không yêu cầu đăng nhập.

## Gói VIP mô phỏng

Database được migration tự động khi khởi động: `users.is_premium` (0/1), `users.premium_expires_at` (UTC ISO datetime) và `songs.is_vip` (0/1). Các tài khoản/bài hát cũ mặc định là Free/thường; dữ liệu còn lại được giữ nguyên.

- Trang `#/premium` có gói 1 tháng (49.000đ), 6 tháng (269.000đ) và 12 tháng (499.000đ). QR chỉ là hình minh họa, không phải mã thanh toán. Người dùng gửi yêu cầu nâng cấp; Admin duyệt thì hệ thống mới cộng thời hạn theo tháng lịch vào cuối hạn VIP hiện tại (nếu còn hạn). Mỗi tài khoản chỉ có thể có một yêu cầu đang chờ cùng lúc.
- Dashboard Admin có bảng yêu cầu VIP với thao tác duyệt/từ chối và lịch sử trạng thái. Duyệt yêu cầu sẽ kích hoạt đúng thời hạn của gói đã chọn; từ chối không thay đổi trạng thái VIP.
- Admin có thể cấp thêm một tháng hoặc hủy VIP ở danh sách người dùng; checkbox trong danh sách bài hát đánh dấu/bỏ đánh dấu bài VIP.
- Bài VIP chỉ phát được khi tài khoản có VIP còn hạn. Backend kiểm tra quyền ở cả API stream và API ghi nhận lượt nghe, nên URL stream trực tiếp cũng không bỏ qua được phân quyền.
- API: `POST /api/premium/requests` với `{ "plan": "month" | "halfYear" | "year" }`; Admin xem qua `GET /api/admin/premium-requests` và xử lý bằng `POST /api/admin/premium-requests/:id/review` với `{ "action": "approve" | "reject" }`. Admin vẫn có thể cấp/hủy VIP thủ công qua `POST /api/admin/users/:id/premium` với `{ "action": "grant" | "revoke" }`; đánh dấu bài VIP qua `PATCH /api/admin/songs/:id/vip` với `{ "isVip": true | false }`.

Đây là chức năng thanh toán giả lập phục vụ demo đồ án, không kết nối MoMo/VietQR và không xử lý tiền thật.

## Hỗ trợ khách hàng

- Bong bóng chat xuất hiện trên mọi trang nghe nhạc. Bot trả lời FAQ theo từ khóa về nghe nhạc, lỗi phát, playlist, đăng nhập và VIP; không gọi API AI bên ngoài.
- Chat bot dùng được khi chưa đăng nhập. Kết nối chuyên viên yêu cầu đăng nhập để gắn cuộc trò chuyện đúng tài khoản.
- Hội thoại/tin nhắn trực tiếp lưu trong SQLite ở `support_conversations` và `support_messages`. Admin chọn mục **Hỗ trợ khách hàng** trong Dashboard để xem danh sách đang chờ, trả lời hoặc kết thúc phiên.
- Widget và Dashboard lấy tin nhắn mới bằng polling khoảng 2 giây; đây là cập nhật gần thời gian thực, không cần WebSocket/dịch vụ ngoài.

`sql.js` chạy SQLite bằng WebAssembly trong tiến trình Node.js và xuất dữ liệu ra file SQLite sau mỗi lần ghi; không cần cài database server riêng. Trước khi chạy `npm run make-admin -- email@example.com`, phải dừng server để file SQLite không bị hai tiến trình cập nhật cùng lúc.