# Akentek PC Bridge DEV — Gelişmiş kontrol

Bu özellik yalnızca **Feno Bridge DEV** profili için tasarlanmıştır. Normal Feno ve Codex'in bağlantılarını değiştirmeden, kullanıcı bilgisayarından **bir kez yerel onay** ile daha geniş geliştirme işi yapılmasını sağlar.

## İzin modeli

- Standart erişim: izin verilen proje köklerinde dosya okuma/yama, yeni dosya ve klasör oluşturma; masaüstü pencere kontrolü; Android emülatörü; mevcut GitHub runner sorgulaması.
- Proje görev kataloğu: projede var olan `test`, `lint`, `build`, `typecheck`, `verify` gibi betikler, Android debug/test ve salt-okunur Git durum komutları. Projedeki betikler yürütülebilir koddur; dosya erişimi açısından OS sandbox'ı değildir.
- **Gelişmiş terminal**: ayrı `terminal.exec` izni ile Windows PowerShell komutları; sabit sistem yürütülebiliri, giriş kapalı, tek terminal işi, 10 dakika sınırı, yerel SHA256 audit kaydı. Komutlar **Windows oturumunun tüm izinleriyle çalışır** ve seçilen proje klasörü bu komutları işletim sistemi düzeyinde sınırlamaz.
- **Geniş masaüstü**: ayrı yerel seçimle Chrome/Edge/Firefox ve Office/PDF süreçleri pencere kapsamına eklenir; ekran ve fare/klavye bu pencerelerdeki giriş yapılmış hesapları da görebilir.
- **Süresiz DEV**: yalnızca Windows `safeStorage` üzerinden şifreli saklama kullanılabiliyorsa ve kullanıcı onayladıysa, izin yeniden açılışta yeni imzalı yerel yetkiyle geri gelir. Süreli onay hâlâ varsayılandır.

## Tek seferlik yerel işlem

1. Feno Bridge **DEV** > Ayarlar > Akentek PC Bridge aç.
2. İzinli proje klasörü olarak `D:\GitHub` gibi ihtiyacın olan **dar üst proje klasörünü** seç. Diskin tamamını seçemezsin; seçilen kök altındaki projeler görülebilir.
3. İstiyorsan **Gelişmiş terminal**, **Geniş masaüstü**, **DEV erişimi süresiz** seçeneklerini işaretle.
4. **İzin ver** veya mevcut izin varsa **Yetkiyi yerel onayla güncelle** düğmesine bas; Windows penceresinde gösterilen klasör, uygulama listesi ve yüksek riskli yetkileri kontrol ederek bir kez onayla.
5. **Acil durdur** tüm erişimi durdurur, çalışan işleri sonlandırır ve şifreli saklanan süresiz izin kaydını da kaldırır.

Uzak MCP araçları kendi kendilerine yerel izin açamaz. Kilitli Windows oturumunda masaüstü işlemleri durur. Yönetici/UAC yükseltme ve Windows güvenlik kısıtlarını aşma özelliği yoktur.

## Yeni araçlar

| Araç | İşlev |
|---|---|
| `pc_create_file` | Yalnızca mevcut olmayan, sınırlandırılmış UTF-8 dosya oluşturur |
| `pc_create_directory` | Onaylı kök altında tek klasör oluşturur |
| `pc_list_project_tasks` | Proje içindeki sabit geliştirici görevlerini listeler |
| `pc_start_project_task` | Görev ID ile test/build/Git kontrolünü başlatır |
| `pc_start_terminal` | Yalnızca ayrı yerel `terminal.exec` izniyle komut çalıştırır |
| `pc_desktop_input` | Ek olarak sağ tık, tekerlek kaydırma ve adlandırılmış klavye kısayolları |

İşlerin durumları, günlükleri ve iptali mevcut `pc_job_status`, `pc_job_logs`, `pc_cancel_job` araçlarıyla yönetilir.

Yama motoru LF ve Windows CRLF satır sonlarını mantıksal satırlar olarak karşılaştırır. Eklenen satırlar dosyanın satır sonu biçimini kullanır; değişmeyen satırların kendi biçimi ve dosyanın son yeni satır durumu korunur. Böylece geçerli bir LF yama, CRLF çalışma kopyasında yanlışlıkla `pc_access_denied / INVALID_ARGUMENT` üretmez. SHA256, kök klasör, gizli içerik ve yerel izin kontrolleri devam eder.

Yeni dosya/klasör oluşturma bu DEV paketinde Windows'a özeldir. Üst klasörler ve yazılan dosya, yeniden adlandırmayı engelleyen yerel tutamaçlarla korunur; açık dosyanın kimliği yazmadan önce karşılaştırılır. Diğer işletim sistemlerinde bu iki yeni işlem güvenli yerel uygulama eklenene kadar kapalıdır. Mevcut dosya okuma/yama araçları bundan etkilenmez. Windows testleri klasör kaçışını yönetici yetkisi gerektirmeyen junction ile sınar; dosya sembolik bağ testi Unix'te çalışır.

Canlı DEV ile uyumluluk için şifreli süresiz seçim `launcher/pc-permanent-consent.enc` dosyasında korunur. Uygulamadan çıkış erişimi askıya alır; pencereyi tepsiye kapatmak erişimi sürdürür. `Acil durdur / İzni sil`, etkin erişimle birlikte kayıtlı seçimi de siler; kayıt silinemiyorsa etkin erişim yine durur ve kayıt bulunduğu arayüzde gösterilir.

## Terminal sonucu, çıktı geçmişi ve pencere odağı

`pc_status` içindeki `terminalBusy` ve `activeJobs` alanları çalışma yuvasının dolu olup olmadığını gösterir; yalnızca onaylı `jobs` izni varken sunulur. `pc_terminal_busy`, aynı hosttaki önceki terminalin kapanmasını beklemek gerektiğini belirtir. `pc_job_busy` eşzamanlı iş sınırıdır; `pc_job_history_full` tutulan iş geçmişinin sınırıdır. Bu durumlar yeni yerel izin gerektirmez. Otomatik olarak başka bir işi iptal etme veya aynı başarısız çağrıyı durmadan tekrarlama.

Eski SHA ile yama çağrısı `pc_sha_mismatch` döndürür. Dosyayı `pc_read_file` ile yeniden oku; yeni SHA ve güncel içerikle yamayı yeniden kur. İzin, proje kökü ve hassas dosya/içerik denetimleri bu hata ayrımından önce uygulanır; gerçek izin ihlalleri `pc_access_denied` kalır.

Terminal, açık bir `exit` komutunun değerini korur. Son komut yerel bir program veya iç içe PowerShell ise başarısızlık kodu PowerShell'in genel `1` değerine indirgenmez; örneğin `17` olarak döner. Başarısız bir programdan sonraki başarılı PowerShell ifadesi, eski `$LASTEXITCODE` nedeniyle başarısız sayılmaz. Süre sınırı, işlem ağacı kapsaması ve iptal davranışı korunur.

`pc_job_logs`, her çağrıda en fazla 250 satır / 64 KiB döndürür. `nextCursor` ile sonraki sayfayı iste; `endCursor` değerine ulaşınca mevcut çıktı tamamlanmıştır. Her işin geçmişi en fazla 20.000 satır / 2 MiB UTF-8 içeriktir. Sınıra ulaşılıp eski satırlar atıldıysa `truncated: true` ve eldeki ilk satırın `firstCursor` değeri döner; eksik geçmiş tam gibi gösterilmez. Çok sayıda satır içeren tek bir terminal paketi satır satır işlenir; stdout ve stderr ayrı UTF-8 çözücüler kullanır. Gizli değerlerin maskelenmesi devam eder.

Masaüstü odağı yalnızca onaylı hedef için istenir. Yerel etkinleştirme başarısızsa hedefin Windows UI Automation sağlayıcısı kullanılır; odaklanamayan Not Defteri çerçevesinde yalnızca kendi odaklanabilir belge alanı seçilir. Ön plandaki alt pencere, ancak seçilen kök pencerenin gerçek çocuğuysa ve aynı işleme aitse geçerli sayılır. Başka işlem/pencere, modal pencere, kilitli oturum ve gerçek odak reddi durumlarında tuş veya tıklama gönderilmez; `pc_focus_required` korunur.

## Yayına geçiş engeli

Canlı Windows Feno Bridge DEV üzerinde **bu depodakinden ayrı** süresiz izin düzeltmeleri zaten bulunuyor. Bu kaynak değişiklikleri canlı Windows değişiklikleriyle karşılaştırılmadan, yedeklenmeden ve Windows'ta test edilmeden **kurulmaz**. Özellikle mevcut `pc_status` sonucundaki `expiresAt: null` korunmalıdır. Kodun geçmesi, canlı Windows'a başarıyla kurulduğu anlamına gelmez.

Doğrulama: PC birim/entegrasyon testleri, launcher birim testleri, iki TypeScript kontrolü, renderer derlemesi, Windows DEV üzerinde araç envanteri, `pc_status`, `pc_runner_status`, emülatör ve acil durdur testi. Windows PowerShell yardımcısı gerçek Windows DEV oturumunda doğrulanmalıdır.
