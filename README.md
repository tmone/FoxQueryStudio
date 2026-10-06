# FoxQuery Studio

Công cụ desktop (Electron) kiểu SSMS cho người quen FoxPro: viết `SELECT` theo cú pháp FoxPro, công cụ dịch sang T-SQL và chạy trên SQL Server. Chỉ dùng để đọc dữ liệu.

## Chạy

```bash
npm install
npm run dev        # chạy chế độ phát triển
npm run build      # build vào out/
npm start          # chạy bản đã build
```

Nếu chạy từ terminal do VS Code extension sinh ra mà cửa sổ không mở, xóa biến `ELECTRON_RUN_AS_NODE` trước khi chạy.

## Kiểm thử

```bash
npm run fixtures   # tải DB Northwind bản Visual FoxPro (chỉ cần một lần)
npm test           # toàn bộ test
npm run test:mutation
npm run typecheck
npm run e2e        # smoke test giao diện, cần build trước
```

| Bộ test | Kiểm gì | Chuẩn đối chiếu |
|---|---|---|
| `test/converter.test.ts` | Chuỗi T-SQL sinh ra từ từng cú pháp FoxPro | Chuỗi mong đợi |
| `test/edge.integration.test.ts` | Gần 600 biểu thức và điều kiện FoxPro, mỗi cái tính trên một bảng 12 dòng toàn giá trị biên (rỗng, `NULL`, số âm, ngày nhuận, chữ có dấu, ký tự đại diện, giá trị đầy cột). Điều kiện được thử cả dạng `WHERE x` lẫn `WHERE NOT (x)` | Visual FoxPro 9 thật |
| `test/northwind.integration.test.ts` | Chuyển DB Northwind (`.dbf/.fpt/.dbc`) sang SQL Server, so từng ô; chạy các truy vấn nhiều bảng, gộp nhóm, truy vấn con, cursor | Visual FoxPro 9 thật, và hàm tham chiếu trong `test/northwind/fox.ts` |
| `test/app.integration.test.ts` | Dịch vụ CSDL của app (phiên theo tab, giới hạn dòng, nạp schema, định dạng giá trị) và luồng dịch rồi chạy, trên DB giống dự án: `nvarchar`, tiếng Việt, `decimal`, `datetime`, `bit`, `nvarchar(max)` | Giá trị tính từ dữ liệu gốc |
| `test/db.contract.test.ts` | Dịch vụ CSDL với driver giả lập đúng hợp đồng sự kiện của `mssql` | Hợp đồng sự kiện |
| `test/localdb.integration.test.ts` | SQL Server chấp nhận cú pháp đã dịch | SQL Server |
| `npm run test:mutation` | Cài lại lần lượt 35 lỗi ngữ nghĩa vào tầng convert và bộ đọc DBF, xác nhận hai bộ đối chiếu FoxPro bắt được. Chạy từng phần bằng `node scripts/mutation-check.mjs <từ> <đến>` | |

Điều kiện chạy: SQL Server LocalDB; `vfp9.exe` cho phần đối chiếu FoxPro (mặc định `D:\SureHCS\tools\vfp9\vfp9.exe`, đổi bằng biến `FQS_VFP_EXE`); fixtures cho bộ Northwind. Thiếu thành phần nào thì phần tương ứng tự bỏ qua. FoxPro chạy không giao diện từ thư mục chép ra, không cần cài vào Windows.

Xem chi tiết chỗ lệch:

- Bộ biên: đặt `FQS_REPORT=test-results/edge-report.txt` rồi chạy test, file liệt kê từng biểu thức lệch theo từng dòng.
- Bộ Northwind: đặt `FQS_DUMP=test-results/dump.json`, rồi `node scripts/show-dump.mjs test-results/dump.json`.

Bộ biên chạy trên database có collation nhị phân (`Latin1_General_BIN2`), để việc SQL Server không phân biệt hoa thường không lẫn vào kết quả kiểm tầng convert. Bộ Northwind và bộ app chạy trên collation mặc định.

### Chạy app thật trên SQL Server thật

`test/e2e/real-server.mjs` mở app đã build, kết nối tới một SQL Server qua TCP bằng driver mặc định (`tedious`) và thao tác như người dùng: hộp thoại kết nối, cây bảng/view, gõ FoxPro, F5, lưới kết quả, tab thứ hai. Mỗi kết quả được so với cùng câu hỏi chạy thẳng bằng `sqlcmd`. Script chỉ đọc (`SELECT` và bảng tạm trong tempdb).

```powershell
$env:FQS_E2E_SERVER='host'; $env:FQS_E2E_PORT='1433'; $env:FQS_E2E_DATABASE='db'
$env:FQS_E2E_USER='login'; $env:FQS_E2E_PASSWORD='...'
npm run build; npm run e2e:real
```

Các bảng trong script (`HCSEM_Employees`, `HCSEM_EmpBasicSalaryTracking`) là của DB dự án SureHCS. Đã chạy trên DB dev của dự án: 2.331 bảng, 724 view, 63.385 cột.

Dịch vụ CSDL còn được kiểm riêng qua LocalDB bằng driver `msnodesqlv8` (LocalDB không mở TCP) và qua test hợp đồng sự kiện.

## Cấu trúc

| Thư mục | Vai trò |
|---|---|
| `src/converter` | Tầng dịch FoxPro sang T-SQL. Module thuần, không phụ thuộc Electron |
| `src/shared` | Kiểu dữ liệu chung, ánh xạ kiểu cột SQL Server sang kiểu FoxPro, luồng dịch rồi chạy một truy vấn |
| `src/main` | Tiến trình chính: dịch vụ CSDL (`mssql`), nạp schema, chạy lệnh |
| `src/preload` | Cầu nối IPC, renderer không giữ chuỗi kết nối |
| `src/renderer` | Giao diện: Monaco editor, cây bảng/view, lưới kết quả |
| `tools/dbf` | Đọc file DBF/FPT/DBC của Visual FoxPro và sinh script tạo bảng, nạp dữ liệu cho SQL Server |
| `tools/vfp` | Chạy mã FoxPro trong Visual FoxPro 9 thật và đọc kết quả về |
| `tools/sqlrun` | Chạy lô lệnh SQL trên LocalDB cho test |

## Cú pháp FoxPro đang hỗ trợ

- `SELECT ... FROM ... WHERE ... GROUP BY ... HAVING ... ORDER BY`, `JOIN`, truy vấn con, `UNION`, `DISTINCT`, `TOP`; nối dòng bằng `;`, chú thích `*` đầu dòng và `&&`.
- `GROUP BY` theo số thứ tự cột hoặc bí danh cột; `HAVING` dùng bí danh cột.
- `INTO CURSOR tên`: cursor thành bảng tạm `#tên`, tồn tại theo tab; truy vấn tiếp trên cursor, `SELECT tên` để chọn vùng làm việc, `BROWSE [FIELDS ...] [FOR ...]`. Cột chưa đặt tên được đặt như FoxPro (`cnt`, `cnt_cột`, `dcnt_cột`, `sum_cột`, `exp_N`), cột trùng tên thêm hậu tố `_a`, `_b`.
- Hằng: `.T.` `.F.` `.NULL.`, `{^yyyy-mm-dd}`, `{^yyyy-mm-dd hh:mm:ss}`, hằng tiền tệ `$1500.50`, chuỗi nháy đơn hoặc nháy kép (chuỗi có dấu tự thành `N'...'`).
- Toán tử: `==`, `!=`, `#`, `!`, `$`, `%`, `^`, `**`, `.AND.` `.OR.` `.NOT.`.
- Trường logic hoặc hằng logic đứng một mình làm điều kiện: `WHERE nghi`, `WHERE !nghi`, `WHERE .T.`, `IIF(nghi, ...)`.
- Hàm: chuỗi (`ALLTRIM LTRIM RTRIM TRIM UPPER LOWER LEFT RIGHT SUBSTR LEN AT ATC RAT OCCURS STRTRAN PADL PADR CHR ASC TRANSFORM STR VAL`), số (`INT MOD ROUND` và các hàm trùng tên T-SQL như `ABS SIGN SQRT CEILING FLOOR`), ngày (`DATE DATETIME YEAR MONTH DAY DOW QUARTER HOUR MINUTE SEC GOMONTH TTOD DTOT DTOC DTOS CTOD`), điều kiện (`IIF ICASE NVL EVL EMPTY ISNULL BETWEEN INLIST`), gộp nhóm (`COUNT SUM AVG MIN MAX`). Hàm không có trong danh sách được giữ nguyên.

## Ngữ nghĩa FoxPro được giữ lại

Những chỗ dịch thẳng sang T-SQL sẽ cho kết quả khác FoxPro. Mọi dòng dưới đây đã được đối chiếu với Visual FoxPro 9 thật.

### So sánh chuỗi

FoxPro (`SET ANSI OFF`, mặc định) chỉ so đến hết chuỗi ngắn hơn. Một cột được coi là có độ rộng cố định, đúng như FoxPro ánh xạ `varchar` của SQL Server thành kiểu Character có đệm khoảng trắng; riêng `varchar(max)`, `nvarchar(max)`, `text` được coi là memo, không có độ rộng cố định.

| FoxPro | Nghĩa | Cách dịch |
|---|---|---|
| `cột = "ab"`, `cột # "ab"` | Bắt đầu bằng `ab`; `cột = ""` luôn đúng | `cột LIKE 'ab%'` / `NOT LIKE` |
| `cột IN ("a", "b")`, `INLIST(cột, "a", "b")` | Như trên cho từng hằng | `(cột LIKE 'a%' OR cột LIKE 'b%')` |
| `ALLTRIM(x) = "ab"`, `memo = "ab"`, `a + b = "ab"` | Bên nào ngắn hơn thì so đến hết bên đó, nên giá trị rỗng cũng khớp | `(x LIKE 'ab%' OR x = LEFT('ab', độ dài x))` |
| `cột = ALLTRIM(y)`, `"ab" = cột` | So đến hết biểu thức | `LEFT(cột, độ dài biểu thức) = biểu thức` |
| `cột > "ab"`, `cột <= "ab"` | Giá trị bắt đầu bằng `ab` được coi là bằng | Thêm điều kiện `LIKE 'ab%'`. `>=` và `<` không đổi |
| `x == y` | So khớp đầy đủ | `x = y` |
| `x LIKE "%c"` | Bỏ qua khoảng trắng cuối của giá trị; `[` là ký tự thường | `RTRIM(x) LIKE '%c'`, `[` thành `[[]` |
| `"b" $ x`, `AT()`, `RAT()`, `OCCURS()`, `STRTRAN()` | Phân biệt hoa thường | So sánh nhị phân (`Latin1_General_BIN2`) |

So khớp theo chuỗi ngắn hơn tắt được bằng tùy chọn `ansi: true` của tầng convert (tương đương `SET ANSI ON`); app hiện dùng mặc định của FoxPro.

### Số, ngày và `NULL`

| FoxPro | Vấn đề nếu dịch thẳng | Cách dịch |
|---|---|---|
| `a / b` | Hai số nguyên bị chia lấy phần nguyên | `a * 1.0 / b` |
| `a % b`, `MOD(a, b)` | Dấu kết quả theo số bị chia | `((a % b + b) % b)` |
| `a ^ b`, `a ** b` | `^` là XOR trong T-SQL | `POWER(CAST(a AS float), b)` |
| `AVG(biểu thức)` | Bị cắt phần thập phân khi là số nguyên | `AVG(1.0 * (x))`. `AVG(cột nguyên)` giữ nguyên vì FoxPro cũng trả số nguyên |
| `VAL("12abc")`, `VAL("-3.7")` | Chuyển kiểu thất bại | Đọc phần số ở đầu chuỗi, không có thì trả 0 |
| `STR(x, n, d)` | Làm tròn theo số thực nhị phân (2.345 thành 2.34) | Làm tròn thập phân trước khi định dạng |
| `LEN(x)` | Bỏ qua khoảng trắng cuối | `LEN(x + N'.') - 1` |
| `PADL(x, n, mẫu)` | Cắt nhầm phía, mẫu lấp bị lệch | Giữ phần bên trái, mẫu lấp bắt đầu từ mép trái |
| `NVL(a, b)` | `ISNULL` cắt `b` theo kiểu của `a` | `COALESCE` |
| `EMPTY(x)` | `NULL` dễ bị tính là rỗng | Chuỗi: `x IS NOT NULL AND x = ''`; số và logic: so với 0. `NULL` không bao giờ là rỗng |
| `EMPTY(cột ngày)` | | Luôn sai, kèm cảnh báo: FoxPro đọc dữ liệu SQL Server không coi ngày nào là rỗng (kể cả `NULL`, 30/12/1899, 01/01/1900). Tìm ngày chưa có bằng `ISNULL(x)` |
| `TRANSFORM(x)` | Ngày ra `yyyy-mm-dd`, logic ra `1/0`, `NULL` ra `NULL` | `dd/mm/yyyy`, `.T.`/`.F.`, và chuỗi `.NULL.` |
| `CTOD("sai")` | Báo lỗi | Trả `NULL` |
| `ngày - ngày`, `ngày ± n` | Lỗi kiểu dữ liệu, hoặc sai đơn vị | `DATEDIFF` / `DATEADD` theo ngày (`datetime`: theo giây) |
| `DOW()` | Phụ thuộc `SET DATEFIRST` | Tính từ một ngày Chủ nhật cố định |
| `WHERE .T.`, `WHERE nghi` | T-SQL không nhận giá trị làm điều kiện | `1 = 1`, `nghi = 1` |

Phép tính ngày, `EMPTY`, `TRANSFORM` và trường logic đứng một mình cần biết kiểu của toán hạng. Công cụ suy kiểu từ kiểu trả về của hàm và từ schema đã nạp, tra theo đúng các bảng trong `FROM`/`JOIN` của câu lệnh (và theo bí danh nếu cột có tiền tố). Tra theo tên cột không thôi là không đủ: trên DB dự án, 34% lượt cột trùng tên nhưng khác kiểu giữa các bảng. Khi các bảng trong câu lệnh cho cùng một tên cột hai kiểu khác nhau thì phải ghi tiền tố bảng. Với cột của cursor thì không suy được; `EMPTY` khi đó so sánh như chuỗi và hiện cảnh báo.

## Khác biệt còn lại so với FoxPro

Các mục có test canh (danh sách `DEVIATIONS` của bộ Northwind và `KNOWN_DIFFERENCES` của bộ biên): test hỏng nếu khác biệt biến mất, để danh sách này không bị lỗi thời.

- **Phân biệt hoa thường:** `=`, `LIKE`, `IN`, `ORDER BY`, `GROUP BY`, `DISTINCT` theo collation của SQL Server, thường không phân biệt hoa thường; FoxPro thì có. Truy vấn trên SQL Server có thể trả nhiều dòng hơn (`city = "london"` ra 0 dòng trên FoxPro, 6 dòng trên SQL Server), và thứ tự sắp xếp chữ hoa/chữ thường khác.
- **Kiểu của cột tính toán:** FoxPro chốt độ rộng và số chữ số thập phân của cột kết quả ngay từ đầu, rồi làm tròn, cắt, hoặc trả `NULL` cho giá trị không vừa. Ví dụ `TRANSFORM(id)` ra `1` cho id 10; `10 / 4` giữa hai hằng nguyên ra 3; `NVL(cột_nguyên, 1.5)` ra 2; `EVL(i, 99)` ra `NULL` khi `i` là 100. SQL Server trả giá trị đầy đủ.
- **Số học kiểu currency:** FoxPro làm tròn 4 chữ số thập phân sau mỗi phép tính; SQL Server giữ nhiều chữ số hơn nên tổng lệch ở phần nghìn.
- **So sánh liên quan độ rộng khai báo của cột:** `cột_a = cột_b` khi hai cột khác độ rộng, và hằng chuỗi dài hơn độ rộng cột. FoxPro so đến hết cột hẹp hơn; công cụ không biết độ rộng khai báo.
- **`LIKE "_"` với giá trị toàn khoảng trắng:** FoxPro cho khoảng trắng đệm khớp với mẫu; công cụ cắt hết khoảng trắng cuối.
- **Cursor không giữ thứ tự dòng:** muốn có thứ tự phải `ORDER BY` khi đọc.
- `DTOC()`/`CTOD()`/`TRANSFORM(ngày)` theo định dạng ngày/tháng/năm, năm 4 chữ số (`SET DATE DMY`, `SET CENTURY ON`).
- `[tên]` là tên định danh SQL Server, không phải chuỗi.
- `MAX(a, b)`, `MIN(a, b)` nhiều tham số: FoxPro cũng không nhận trong `SELECT`.
- Biểu thức logic trong danh sách cột (`SELECT a > b AS lon`) không chạy được trên SQL Server.
- Chưa hỗ trợ: lệnh thủ tục (`USE`, `SCAN`, `REPLACE`, `SEEK`), macro `&`, `INTO TABLE/ARRAY`, phép trừ chuỗi.

## Chuyển DB FoxPro sang SQL Server

`tools/dbf` ánh xạ kiểu như sau: `C` thành `nchar(n)` (giữ độ rộng cố định như FoxPro), `V` thành `nvarchar(n)`, `M` thành `nvarchar(max)`, `I` thành `int`, `N/F` thành `decimal`, `Y` thành `money`, `B` thành `float`, `L` thành `bit`, `D` thành `date`, `T` thành `datetime`. Ngày rỗng thành `NULL`. Bản ghi đã đánh dấu xóa bị bỏ qua. Trường General, blob và memo nhị phân không được chuyển. Tên cột dài lấy từ file `.dbc`.

## An toàn dữ liệu

Việc chỉ đọc phải được đảm bảo ở SQL Server: cấp cho công cụ một login riêng chỉ có quyền `SELECT` trên các view/bảng đã thống nhất. Công cụ chỉ dịch `SELECT` và `BROWSE`, nhưng đó không phải lớp bảo vệ. Mật khẩu không được lưu xuống máy. Kết quả giới hạn 5000 dòng mỗi bảng.

## Hướng mới: extension VS Code (nhánh `feature/vscode-extension`)

Thư mục `extension/` là bản mẫu extension VS Code dùng lại extension `ms-mssql.mssql` của Microsoft (MIT, có trên Open VSX) cho kết nối, cây đối tượng và lưới kết quả; phần của mình chỉ còn tầng dịch và lệnh chạy.

Quyết định 06/10/2026: dùng mssql nguyên gốc (bản 1.46), không fork; bản phân phối sau này đóng gói sẵn `.vsix` của nó. Chỉ fork và tinh gọn khi có nhu cầu bản gốc không đáp ứng được (kết quả gắn với tab FoxPro, bỏ cảnh báo thừa, lược phần Azure/Copilot).

- Ngôn ngữ `foxsql` (`.fox`, `.fsql`), tô màu theo grammar `syntaxes/foxsql.tmLanguage.json`.
- F5 trên tệp FoxPro: dịch sang T-SQL vào một tài liệu kề bên (mỗi tab FoxPro một tài liệu T-SQL), rồi gọi `mssql.runQuery`. Cursor giữ được giữa các lần chạy vì mssql giữ một kết nối theo từng tài liệu.
- Lỗi và cảnh báo dịch hiện trong Problems khi gõ.
- Lần đầu chạy, extension thu gọn giao diện theo kiểu SSMS (`src/layout.ts`): giao diện sáng, ẩn thanh hoạt động, thanh phụ, minimap, breadcrumbs; cây đối tượng của mssql ở trái; tài liệu T-SQL nằm dưới editor FoxPro; kết quả và thông báo ở khung dưới cùng. Lệnh "FoxQuery: Khôi phục bố cục mặc định" để hoàn tác.
- Chạy thử thật: `cd extension && npm run build && FQS_E2E_PASSWORD=... node test/drive.mjs` mở một VS Code tách riêng (`.vscode-test/`, cài sẵn mssql, hồ sơ kết nối trong `user-data/User/settings.json`) và lái như người dùng: F5, chọn kết nối, nhập mật khẩu, đọc lưới kết quả, tạo cursor rồi `BROWSE` ở lần chạy sau.

Đã biết: khung kết quả của mssql gắn với tài liệu T-SQL, nên khi bấm sang tab FoxPro khung này báo "No results for the active editor"; và mssql hiện một cảnh báo "Result set index cannot be less than 0" khi lệnh không trả bảng (như `INTO CURSOR`), lệnh vẫn chạy đúng. Kiểm lỗi IntelliSense của mssql được tắt vì nó không thấy bảng tạm của lần chạy trước. Chưa có gợi ý theo schema cho `.fox` và chưa có chiều dịch T-SQL sang FoxPro.
