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

## Yayına geçiş engeli

Canlı Windows Feno Bridge DEV üzerinde **bu depodakinden ayrı** süresiz izin düzeltmeleri zaten bulunuyor. Bu kaynak değişiklikleri canlı Windows değişiklikleriyle karşılaştırılmadan, yedeklenmeden ve Windows'ta test edilmeden **kurulmaz**. Özellikle mevcut `pc_status` sonucundaki `expiresAt: null` korunmalıdır. Kodun geçmesi, canlı Windows'a başarıyla kurulduğu anlamına gelmez.

Doğrulama: PC birim/entegrasyon testleri, launcher birim testleri, iki TypeScript kontrolü, renderer derlemesi, Windows DEV üzerinde araç envanteri, `pc_status`, `pc_runner_status`, emülatör ve acil durdur testi. Windows PowerShell yardımcısı gerçek Windows DEV oturumunda doğrulanmalıdır.
