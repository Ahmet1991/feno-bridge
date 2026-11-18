# Görev 9 — Kendi Chrome'u, Feno Bridge PC2 5.1.19

Tarih: 18.11.2026. Hedef: PR #97, `feat/normal-pc2-next-5.0.96`.

## Uygulama

- MV3 uzantısı kullanıcının Chrome profilindeki sekmelerle çalışır. Sabit kimlik: `mcimkhafgpcecjdjjiljhljdkaggapfa`. Native host: `com.feno.bridge.pc2`. Kurucu HKCU kayıt anahtarını oluşturur, kaldırıcı siler; allowed_origins yalnız sabit uzantıyı içerir.
- `debugger` CDP ekran görüntüsü ve gerçek koordinat girdisi, `tabs` sekme listesi ve arka plan gezinmesi, `scripting` DOM ve imleç kaplaması, `nativeMessaging` yerel iletişim, `activeTab` kullanıcı tarafından seçilen sekmeye sınırlı erişim, `alarms` yeniden bağlantı içindir. HTTP(S) host izinleri farklı sitelerde çalışmak içindir. Gizli mod ve dış site mesajlaşması kapalıdır.
- Yerel host uzunluk önekli JSON ile konuşur; rastgele portlu, kimlik doğrulamalı loopback broker ve oturum denetimi komutları köprüyle sınırlar. Bağlantı kopması, zaman aşımı ve yetki iptali ele alınır.
- Ayarlar bölümünde bağlantı/sürüm, aç/kapat, uzantı klasörü ve Chrome uzantıları sayfasına erişim bulunur. Varsayılan kapalıdır; `chrome.user` yalnız tam yetkide verilir. Paket güncellemesi sabit uzantı klasörünü yeniler; sürüm uyuşmazlığında uzantı yeniden yüklenir.
- Sekme listeleme, açma, gezinme, okuma, bulma, koordinatlı bilgisayar girdisi, ref ile tıklama/yazma: sekiz `pc_chrome_*` aracı. Yeni sekme pasiftir. Ekran görüntüsü uzayındaki koordinatlar doğrulanır; ref ve görüntü eskimesi denetlenir. Görünür imleç, tıklama halkası ve PC2 rozeti vardır. Debugger işlem sonrası yaklaşık 2,5 saniyede ayrılır.
- HTTP(S) dışı sayfalar ve Chrome Web Store engellenir; hassas şifre/ödeme girdilerinde kullanıcı onayı uyarısı uygulanır. Okuma içeriği güvenilmez veri olarak etiketlenir. Denetimde araç, sonuç ve alan adı dışında sayfa içeriği/yazılan metin tutulmaz.

## Doğrulama

| Kapı | Sonuç |
| --- | --- |
| Odaklı Bun testleri | 10 başarılı, 0 hata |
| Native host/broker ve worker testleri | 4 başarılı, 0 hata |
| Kök testleri | 1229 başarılı, 5 atlanan, 0 hata |
| Launcher `bun run scripts/test-launcher.cjs` | Node 432 başarılı, 3 atlanan, 0 hata; Bun 43 başarılı, 0 hata |
| Kök ve launcher typecheck | Geçti |
| Sürüm | VERSION_SYNC_OK 5.1.19 |
| Gerçek Chromium geçici profil/odak | OWN_CHROME_SMOKE_OK |
| Paket üretimi | Exit 0 |
| Paket açılışı | PACKAGED_LAUNCHER_SMOKE_OK, 5.1.19, win32/x64, runtimeVerified=true, cdpStatus=200 |
| Paket uzantısı ve yardımcı SHA | PACKAGED_CHROME_EXTENSION_OK; iki PACKAGED_HELPER_SHA256_OK |

Gerçek Chromium testinde yerel sayfada canvas tıklaması, yazma, okuma, imleç dahil/hariç ekran görüntüsü doğrulandı. Son koşuda ayrı ön plan örnekleyicisi 13 örnek aldı, odak değişimi 0; etkin sekme değişmedi. Test geçici profilde yapıldı. Native host ayrıca gerçek derlenmiş ikili ve sahte Chrome portu ile sınandı; Chromium dumanı test çalışanını kullanır. Bu nedenle gerçek Chrome uzantısından canlı native host'a tam uçtan uca bağlantı ve gerçek HKCU kurulum/kaldırma henüz doğrulanmış değildir. Kasıtlı olarak canlı kurulum yapılmadı.

İlk odaklı testte iki yetki fixture hatası, ilk kök testinde iki sıralama/yetki fixture hatası görüldü; düzeltildi ve son kapılar sıfır hatayla geçti. İlk paket koşusunun PowerShell stderr yönlendirmesi çıkış kodunu 1 yaptı; son paket komutu gerçek çıkış kodunu koruyarak 0 döndü. PowerShell NativeCommandError satırları Bun'un stderr komut başlıklarından kaynaklandı; son kapı ve paket dumanı çıkış kodları 0.

İlk `git commit` çağrısı (741a2a) `Author identity unknown` ve `fatal: unable to auto-detect email address (got 'AHMET@DESKTOP-EQ8NMMQ.(none)')` döndürdü. Önceki üç commit'in doğrulanmış kimliği yalnız bu commit komutuna `git -c` ile verildi; kalıcı Git ayarı değiştirilmedi.

## Paket ve sınırlar

`launcher/artifacts/feno-bridge-5.1.19-win-x64.exe` — 162.432.619 bayt.

- Kurucu SHA-256: `e0f6702bcb8fb7be733812540a5d2076e0d380a0982bf05328f1ddb2fdcd52ff`; yanındaki .sha256 ile eşleşir.
- Windows yardımcı SHA-256: `4fe08f05829202416dc8cdf860576eb70c98d9c844df0fb4f766b1916e35ee92`.
- Chrome native host SHA-256: `b533892e3fa6fa80e4f26f98edae89176844c2446f6f7761eafa5b5196f532a4`.
- Defender önce/sonra etkin, gerçek zamanlı koruma açık; ayar değiştirilmedi. DEV kalıcı izin SHA-256: `5a19c30d19650dcb0250d61fc6e53836e356b3152f6300e620113913113e4bef`, beklenenle eşleşti.
- Canlı PC2 araçları, ana Chrome profili, canlı köprü, kayıt/izin ayarları ve tüneller kullanılmadı/değiştirilmedi. Kurucu çalıştırılmadı; duman için paket ayrı alana açıldı. Merge, etiket ve CI bekleme yok.

Kısıtlar: iframe içi koordinat eylemleri güvenlik nedeniyle engellenir; şifre/ödeme tespiti dar kurala dayanır, bütün özel siteleri kapsadığı iddia edilmez. Yetki iptalinde başlamış eylemin kısa bir süre devam etme olasılığı vardır. Gerçek kullanıcı profili ve kurucu entegrasyonu ancak kullanıcı tarafından kurulup bağlandıktan sonra ayrıca doğrulanabilir.

## Kullanıcının tek seferlik uzantı yüklemesi (5.1.19 kurulduktan sonra)

1. Feno Bridge → Ayarlar → Chrome uzantısı: **Uzantı klasörünü aç** ve **Chrome uzantılar sayfasını aç** düğmelerine bas.
2. Chrome'da **Geliştirici modu**nu aç, **Paketlenmemiş öğe yükle** ile açılan uzantı klasörünü seç.
3. Feno Bridge'de Chrome uzantısını etkinleştir; bağlantı durumunun bağlı ve sürümün 5.1.19 olduğunu kontrol et.

## Devam: canlı deneme düzeltmeleri (5.1.20)

Tarih: 18.11.2026. PR #97, `feat/normal-pc2-next-5.0.96`; başlangıç HEAD `b0d776d`, origin ile fark 0/0.

- Arka plan kaydırması CDP mouseWheel beklemesi yerine koordinattaki öğenin en yakın kaydırılabilir atasına, bulunamazsa document.scrollingElement'e DOM scrollBy uygular. İmleç ve yeni öğe/sayfa kaydırma konumları döner.
- Komut zaman aşımı worker'da AbortController ve native host'ta komut kimlikli iptal ile ele alınır; geç gelen sonuç atlanır, port korunur ve yalnız etkilenen sekmenin debugger oturumu sıfırlanır. Debugger yeniden kullanılır ve 15 saniye boşta kalınca ayrılır; mevcut imleç kaplaması tekrar eklenmez.
- İlk ekran görüntüsü yoksa `pc_chrome_screenshot_required` (Önce screenshot al), eski görüntü/ref için `pc_chrome_ref_stale`. Chrome ve ayrı tarayıcı tuşları büyük/küçük harfe duyarsız; Esc/Escape eşdeğer.
- Tam yetki ve eşleşen uzantı sürümüyle ilk bağlantıda, yalnız ayar dosyası yoksa erişim açılır. Kullanıcının açıkça kapattığı ayar korunur; tam yetki yoksa `pc_access_denied`. Kapalı erişim ipucu: Feno Bridge → Ayarlar → Chrome uzantısı → Chrome erişimini aç.

### Test kapıları

| Kapı | Sonuç |
| --- | --- |
| Odaklı Node (engine, worker, broker ve gerçek derlenmiş host/sahte port) | 6 başarılı, 0 hata |
| Odaklı Bun (Chrome client, browser, MCP, tam yetki) | 14 başarılı, 0 hata; 172 doğrulama |
| `bun test ./tests` | 1230 başarılı, 5 atlanan, 0 hata; 7801 doğrulama |
| Launcher `bun run scripts/test-launcher.cjs` | Node 434 başarılı, 3 atlanan, 0 hata; Bun 43 başarılı, 0 hata |
| `bun run typecheck` | Exit 0 |
| `bun run launcher:typecheck` | Exit 0 |
| `bun run check-version` | VERSION_SYNC_OK 5.1.20 bun@1.4.0 |
| `git diff --check` | Exit 0; çalışma kopyası LF/CRLF uyarıları |
| Gerçek Chromium, geçici profil | OWN_CHROME_SMOKE_OK |
| `bun run app:package` | Exit 0 |
| `bun run app:smoke` | PACKAGED_LAUNCHER_SMOKE_OK, 5.1.20 win32/x64, runtimeVerified=true, cdpStatus=200, runtimeStartupVerified=true, pcServiceStarted=true |
| Paket uzantısı ve iki yardımcı SHA | PACKAGED_CHROME_EXTENSION_OK 5.1.20; iki PACKAGED_HELPER_SHA256_OK |

Gerçek Chrome for Testing (Chromium 1255), geçici profil ve pasif yerel test sekmesi: iç kaydırma 100 piksel (sayfa 0), sayfa kaydırması 600 piksel; imleç, canvas tıklaması ve yazma doğrulandı. Takılan CDP komutu zaman aşımına uğradı, sonraki ekran görüntüsü başarılı; 15 saniyelik boşta ayrılma doğrulandı. Ayrı ön plan örnekleyicisinde 112 örnek, 0 odak değişimi; etkin sekme değişmedi.

| İşlem | Ortanca (ms) | Hedef |
| --- | ---: | ---: |
| Click | 20 | ≤1500 |
| Hover | 15 | ≤1500 |
| Type | 4 | ≤1500 |
| Key | 4 | ≤1500 |
| Screenshot | 32 | ≤1500 |

Ölçümler test çalışanı/Playwright üzerinden engine çağrılarıdır; canlı MCP/native transport uçtan uca gecikmesi ölçülmedi. Click 10 örnek, diğerleri 5'er örnek; en yavaş click 1020 ms, hover 1014 ms. İlk gerçek dumanın debugger ayrılma kontrolü Playwright'ın kendi bağlantısı nedeniyle başarısız oldu; uzantının gerçek detach tamamlanmasını ölçen kontrolle son duman geçti. Önceki canlı hata kayıtları kırmızı kanıtıdır; eski sürümde yeni birim testlerinin ayrı kırmızı koşusu yapılmadı. Takılan CDP sendCommand sınandı; attach/detach çağrılarının kendilerinin takılması ayrı sınanmadı.

### Paket ve korunmuş sınırlar

`launcher/artifacts/feno-bridge-5.1.20-win-x64.exe` — 162.433.797 bayt.

- Kurucu SHA-256: `79d42f0e6fd02af751fda88cfaad26933333235f0669a7835d6a86395f8012a0`; yanındaki `.exe.sha256` ile eşleşiyor.
- Windows yardımcı SHA-256: `76b65d98489ef8d20ef9f8df3e5a60d13b36cfbc345f2609fc7a4eaa12ea9f63`.
- Chrome native host SHA-256: `332c22cb630347eb2e0dae952dc64fdf92d92d15365e51a558e9604c2667f6e2`.
- Defender önce/sonra: AntivirusEnabled, RealTimeProtectionEnabled, BehaviorMonitorEnabled, IoavProtectionEnabled dört değer de True. DEV kalıcı izin SHA-256 önce/sonra: `5a19c30d19650dcb0250d61fc6e53836e356b3152f6300e620113913113e4bef`.
- Canlı PC2 araçları kullanılmadı; ana Chrome profili, canlı köprü/izin/config/tüneller ve DEV ayarları değiştirilmedi. Kurucu çalıştırılmadı; paket ayrı test alanına açılıp doğrulandı. Bir sonraki canlı uçtan uca doğrulama kurulumdan sonra yapılmalıdır. Merge, etiket ve CI bekleme yok.

## Devam: gizli sekme hızı (5.1.21)

18.11.2026 — PR #97, `feat/normal-pc2-next-5.0.96`; karşılaştırma tabanı 5.1.20, `b4b0498`.

Chrome for Testing (Chromium 1255), geçici profil, normal pencere ve iki sekme ile gerçek gizli sekme testi yapıldı. Test sekmesinde her işlem başlangıcında ve sonunda `document.visibilityState === 'hidden'` doğrulandı. Eski sürümde fare gecikmesi yeniden üretildi; son karşılaştırma aşağıdadır.

| İşlem | Örnek | 5.1.20 ortanca / en kötü (ms) | 5.1.21 ortanca / en kötü (ms) | Hedef |
| --- | ---: | ---: | ---: | --- |
| Click | 5 | 5023 / 5990 | 64 / 366 | Geçti |
| Hover | 5 | 5046 / 6349 | 43 / 168 | Geçti |
| Ref ile type | 5 | 5160 / 17741 | 96 / 160 | Geçti |
| Screenshot | 20 | 162,5 / 401 | 134 / 315 | 20/20, geçti |

Eski sürümün 20 ekran görüntüsü de başarılıydı; canlı 5.1.20'deki 30 saniyelik aralıklı takılma doğal olarak yeniden oluşmadı. Yapay ilk yakalama takılması son sürümde ikinci denemeyle 1946 ms içinde aşıldı. Eski sürümün son ölçümünde 489 ön plan örneğinde 127 değişiklik görüldüğü için odak doğrulaması başarısız oldu; test Chrome PID'si hiçbir örnekte ön planda değildi. Son sürümün ölçümünde 32, bütün gerçek gizli sekme dumanında 141 örnekte 0 ön plan değişikliği oldu; etkin sekme değişmedi. 10 click, 5 input ve 15 mousemove olayının tamamı gerçek (isTrusted), sahte JS click yok.

### Uygulama ve doğrulama

- Geçici screencast tek başına fareyi hızlandırmadı; yalnız odak emülasyonu yaklaşık 1 saniye sürdü. İkisi birlikte hedefi karşıladı. Fare olayları sıralı gönderilip birlikte bekleniyor. Odak emülasyonu sırasında sayfa geçici olarak visible bildirdi (15 kez); işlem sonunda hidden geri geldi. OS pencere odağı ve etkin sekme değişmedi.
- Screencast normal, hata ve iptal yolunda durdurulur; durdurma takılırsa debugger ayrılır. Odak emülasyonu da temizlenir.
- Screenshot ilk yakalama için 1300 ms iç sınır kullanır; hata halinde sınırlı ikinci deneme yapılır. Chrome `fromSurface:false` seçeneğini reddettiği için güvenli yeniden denemede surface=true ve gizli sekmede geçici odak emülasyonu kullanıldı.
- Sayfa kaydırması koordinat ref'ini eskitmez; belge, görünüm boyutu, ölçek veya DPR değişince eski ref reddedilir. Üç ardışık scroll ve ardından hover doğrulandı. Araç açıklamasına yeni ekran görüntüsü alma notu eklendi.
- Gerçek duman: `OWN_CHROME_SMOKE_OK`; scrollY=600, imleç, canvas, yazma, zaman aşımı sonrası toparlanma, boşta debugger ayrılması ve etkin sekme korunması başarılı. Ölçüm uzantı engine üzerinden yapıldı; canlı MCP/native transport uçtan uca denenmedi.

| Kapı | Sonuç |
| --- | --- |
| Odaklı Node | 7 başarılı, 0 hata |
| Odaklı Bun | 14 başarılı, 0 hata; 172 doğrulama |
| Kök Bun | 1230 başarılı, 5 atlanan, 0 hata; 7801 doğrulama |
| Launcher (ayrı süreç) | Node 435 başarılı, 3 atlanan, 0 hata; Bun 43 başarılı, 0 hata |
| Kök ve launcher typecheck | İkisi de exit 0 |
| Sürüm | VERSION_SYNC_OK 5.1.21 bun@1.4.0; manifest dahil |
| Paket | app:package exit 0 |
| Gerçek paket açılışı | PACKAGED_LAUNCHER_SMOKE_OK 5.1.21 win32/x64; runtimeVerified=true, cdpStatus=200, runtimeStartupVerified=true, pcServiceStarted=true |
| Paket uzantısı ve iki yardımcı | PACKAGED_CHROME_EXTENSION_OK 5.1.21; iki PACKAGED_HELPER_SHA256_OK |

### Paket ve güvenlik

`launcher/artifacts/feno-bridge-5.1.21-win-x64.exe` — 162.434.616 bayt.

- Kurucu SHA-256: `c8471c936a20d36e5863b53182a6768b4226154d9ed3b883fb9a7f50c947d86e`; yanındaki `.exe.sha256` oluşturuldu ve eşleşme doğrulandı.
- Windows yardımcı SHA-256: `39a62b39af00fc7a2208d4ade35ff32d66a9292421dde4389504757b5ac2ca81`.
- Chrome native host SHA-256: `c28f1dc49a549d96a090a625b515d9d0c1efde85a73d680068b588cb187941cb`.
- Defender önce/sonra dört koruma değeri True, imza 1.463.344.0. DEV kalıcı izin dosyası önce/sonra SHA-256: `5a19c30d19650dcb0250d61fc6e53836e356b3152f6300e620113913113e4bef`.
- Canlı PC2 araçları, kullanıcı Chrome profili, canlı kurulum, tüneller ve izin ayarları kullanılmadı/değiştirilmedi. Kurulum, merge, etiket ve CI bekleme yapılmadı.
