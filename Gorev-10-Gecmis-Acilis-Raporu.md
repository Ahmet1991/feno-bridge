# Görev 10 — İş geçmişi, hızlı açılış ve uyanış dayanıklılığı

**Sürüm:** 5.1.24 · **Dal:** `feat/normal-pc2-next-5.0.96` · **PR:** #97 (taslak)
**Taban:** `75b1adc6256c9b4b5509ca692e4018cb82ba2106` (5.1.23).

## K-1 — İzin soyu ve işlerin görünürlüğü

15 saniyeyi aşan kalp atışı kesintisi izin kimliğini yeniliyordu. İş geçmişi, durum, günlük, iptal ve terminal sahipliği o değişken kimliğe bağlı olduğundan 20 kayıt diskte kalmasına rağmen uyanıştan sonra görünmüyordu.

Geçerli onay kapsamına bağlı `lineageId` eklendi. Kalp atışı, geçici bağlantı kesintisi ve kalıcı tam yetki açıkken launcher yeniden başlatması aynı soyu korur; imzalı kısa ömürlü izin kimliği yine yenilenir. Kalıcı soy özel ACL'li dosyada tutulur. Yetki kapatma, geri alma veya kapsam değişiminde soy yenilenir. Çalışan işin sahipliği, geçmişi ve terminal grubu aynı soy üzerinden denetlenir. Eski biçimli kayıtlar yalnız eski izin kimliği ile eşleşir; görünmemeleri kabul edilen uyumluluk davranışıdır. Komut metni ve çıktı geçmiş dosyasına eklenmedi.

Testler izin yenilemesi, yeni kanal anahtarı ile launcher yeniden başlatması, çalışan işin durum/günlük/iptal işlemleri, kapsam daraltma ve geri alma ile eski kayıtların yalıtımını kapsar. İşin kendisi süreç kapanışında sonlanırsa geçmişte `interrupted` görülür; süreçler arası ham çıktı kalıcılığı eklenmedi. Windows'un gerçek yeniden başlatması canlı ortamda yapılmadı.

## K-2 — Açılış yolu

Eski açılış yolunda kaynak doğrulaması ve eşzamanlı runtime kurulum/doğrulaması ana süreci bekletiyordu. Aynı sürüm için dosya envanteri ve tam içerik karması tekrar okunuyordu. Soğuk disk ve Defender etkisi olasıdır; önceki toplam süreler bu iki etkenin ayrı payını kanıtlamaz.

Yeni yol kaynak ve hedef için manifest kimliğini, dosya sayısını, boyutları, mtime/ctime ve diğer dosya metaverilerini denetler. İlk başarılı tam doğrulamada kimlik ve parmak izi Electron safeStorage (Windows DPAPI) ile korunan makbuza kaydedilir. Hızlı yol eşleşen makbuzla tam içeriği tekrar okumadan ilerler. Ağır I/O eşzamansız gerçekleşir; tam karma kontrolü runtime/izin hazırlığından sonra arka planda yapılır. Hata durumunda makbuz geçersizleşir, runtime ve izin hizmeti durdurulur; sonraki açılış tam doğrulama ve gerekiyorsa onarım yapar. Metaveri uyuşmazlığı hızlı yolu atlar. İşlem öncesi/sonrası kararlılık da denetlenir.

**Güvenlik sınırı:** DPAPI makbuzu harici yayıncı imzası değildir; aynı Windows kullanıcısı adına çalışan saldırgana karşı bağımsız güven kökü sayılmaz. Metaveriyle fark edilemeyen içerik değişiklikleri için ertelenmiş tam karma çalışana kadar kısa bir tespit gecikmesi vardır. Arka plan doğrulaması başarısız olursa köprü kapatılır. Canlı kurulum üzerinde kurcalama testi yapılmadı; bozuk dosya ve makbuz testleri geçici dizindedir.

### Ölçümler

18.11 tarihli 5.1.23 canlı günlükleri UTC; 5.1.24 ölçümleri NSIS çalıştırmadan çıkarılan aynı paket ve aynı geçici veri klasörü ile iki başlatmadır. Süreler saniyedir.

| Ölçüm | runtime_source | runtime_install | Toplam | Arka plan karma |
|---|---:|---:|---:|---:|
| 5.1.23 canlı soğuk açılış | 84,800 | 157,100 | 241,900 | — |
| 5.1.23 kurulum sonrası ilk açılış | 76,800 | 30,100 | 106,900 | — |
| 5.1.23 normal yeniden başlatma | 2,000 | ölçülmedi | ölçülmedi | — |
| 5.1.24 paket ölçümü 1, ilk açılış | 0,361 | 46,685 | 47,046 | — |
| 5.1.24 paket ölçümü 1, ikinci açılış | 0,396 | 0,325 | **0,721** | 6,391 |
| 5.1.24 paket ölçümü 2, ilk açılış | 0,419 | 47,712 | 48,131 | — |
| 5.1.24 paket ölçümü 2, ikinci açılış | 0,385 | 0,320 | **0,705** | 4,249 |

Başarılı ikinci ölçümün ilk açılış alt aşamaları: kaynak metaverisi 0,388 s, kaynak karma 1,751 s, kopya 9,075 s, staging karma 28,604 s, son karma 2,583 s, makbuz 0,507 s. İkinci açılışta kaynak metaverisi 0,369 s ve hedef metaverisi 0,319 s. Staging karma bu ölçümde en pahalı adımdır.

5.1.23 canlı açılış `19:48:12` ve `full_access_enabled` `19:52:30` (258 s); daemon `19:52:33` (261 s). 5.1.24 sıcak tekrar açılışı 3 s hedefini iki kez geçti. 20 s soğuk tekrar açılış ve canlı tam yetki ≤60 s hedefi doğrulanmadı: paket dumanı izole runtime ve PC hizmeti başlatır; gerçek tüneli, canlı yetkiyi veya Windows yeniden başlatmasını kullanmaz. İlk kurulum süresini soğuk tekrar açılış olarak göstermiyorum.

## K-3 — Uyanış dayanıklılığı

5.1.23 canlı kayıtta uyanış 19:36:15, tünel yenilemesi 19:36:21; geçici özel depolama hataları 19:43'e kadar, askıya alma 19:39:58, kurtarmalar 19:40:07 ve 19:40:44. Eski olaylarda işlem adı ve native hata kodu yoktu. Kodda yardımcı süreç zaman aşımı (3 s) ile Windows erişim/paylaşım/kilit kodları 5, 32 ve 33 olası kaynaklardır. Eski logdan hangisinin gerçekleştiği saptanamaz.

Resume ve kilit açılışından sonraki 60 s boyunca yalnız geçici depolama hatalarına sınırlı geri çekilme uygulanır; askıya alma sayacı bunlarla artmaz. Pencere sonrasında mevcut kanal eşiği (en az üç hata ve 30 s) korunur. Güvenlik hataları bekletilmez. Tam yetki kurtarmasında da sınırlı yeniden deneme (en çok 8 s geri çekilme) kullanılır. `heartbeat_transient_error`, `auto_suspended`, `full_access_recovery_failed` olaylarına güvenli `op` ve mevcutsa `nativeCode` eklenir; yol/çıktı yazılmaz. Gerçek uyanış tekrar testi yapılmadı; sahte saat ve hata enjeksiyonu testleri geçti.

## Kapılar ve paket

| Kapı | Sonuç |
|---|---|
| Odaklı kök (4 dosya) | 33 başarılı, 0 başarısız, çıkış 0 |
| Kök (118 dosya) | 1.233 başarılı, 5 atlanan, 0 başarısız; 7.832 assertion |
| Launcher Node | 441 başarılı, 3 atlanan, 0 başarısız |
| Launcher Bun | 44 başarılı, 0 başarısız |
| İki typecheck | çıkış 0 |
| Sürüm denetimi | `VERSION_SYNC_OK 5.1.24 bun@1.4.0` |
| Paket | `bun run app:package` çıkış 0 |
| Gerçek paket dumanı | `PACKAGED_LAUNCHER_SMOKE_OK win32/x64`, CDP 200, runtime ve PC hizmeti hazır |
| Gizli Chrome dumanı | `BROWSER_SMOKE_OK`, 101 örnek, 0 odak değişimi, 0 Chrome örneği |

Kök testlerinin ilk çalıştırmasında sürüm bağlantısı uyuşmazlığı vardı; README'ler düzeltildi. Son koşunun test özeti sıfır hata gösterir. PowerShell `*>` yönlendirmesi Bun'ın stderr yazımı nedeniyle `NativeCommandError` ve dış kabuk çıkışı 1 oluşturdu; bu ayrı olarak bildirilmektedir. Doğrudan launcher kapısı çıkış 0 ile tekrar geçti. İlk tam tarayıcı dumanı test penceresine odak alamadı; gizli moda özel pasif örnekleyici ile gerçek test geçti. İlk paket dumanında diğer uygulamalar arası odak değişimi nedeniyle örnekleyici aşırı katıydı; kayıtta Chrome veya Feno Bridge yoktu. Hata hedef süreçlere göre düzeltilip paket dumanı yeniden çalıştırıldı: 463 örnek, 213 başka uygulama odak değişimi, **0 Chrome, 0 Feno Bridge**. Örnekleyici hiçbir pencereyi etkinleştirmedi. Yeni testlerin değişiklik öncesi kırmızı çıktısı kaydedilmedi; son yeşil koşular ve gerçek başarısız denemeler yukarıda ayrı belirtilmiştir.

Paket: `launcher/artifacts/feno-bridge-5.1.24-win-x64.exe`.
SHA-256: `4b5ddd1b7e652cc25f43e145a7baad8f12b26d085371e643374c7cfac6ada1ab` — yan dosyayla tekrar karşılaştırıldı (`True`).
Paketli `pc-windows-helper.exe`: `1c3c3fb7e4fc65f10aa371a4eaa8c7712d42776094bc89559d1bdb261aee047b`.
Paketli `chrome-native-host.exe`: `0c604303f9ca40ec5cd4e0afc443a0ed5ee8e6e7c893ea0cf7f3d59177a72f99`.
Her iki yardımcı kendi `.sha256` dosyasıyla eşleşti; uzantı paket içeriği ve manifest 5.1.24 doğrulandı.

Defender `MsMpEng` önce 1 (PID 3348), sonra 1 (aynı PID), CPU alanı boş olduğundan CPU farkı ölçülemedi. DEV kalıcı izin SHA-256 önce ve sonra aynı: `5a19c30d19650dcb0250d61fc6e53836e356b3152f6300e620113913113e4bef`.

Canlı PC2 araçları, kurulum, Chrome profili, canlı tünel, izinler ve iş geçmişine müdahale edilmedi. Paket kurulmayan izole test içindir; merge, etiket ve CI bekleme yoktur.

## Devam: kilit kurtarma (5.1.25)

19.11.2026 — Yarım kalan yedi dosyadaki değişiklikler incelendi ve K-4–K-7 tamamlandı. Karşılaştırma tabanı `origin/feat/normal-pc2-next-5.0.96` (`4e4a6ef`).

- **K-4:** Ölü sahip ve PID yeniden kullanımı, işlem kimliği ve başlangıç zamanı ile doğrulanarak güvenli kilit kurtarma yapılıyor. İş/terminal için kapanışta süreçleri öldüren Job Object doğrulandı. Masaüstü/ADB yardımcısının kalmadığı native süreç gözlemiyle doğrulanamadığında kilit korunuyor. Canlı, okunamayan veya bozuk kayıtlar güvenli biçimde reddediliyor. Açılış taraması aynı kuralları uyguluyor; `pc_control.resource_recovered` yalnız işlem türü ve nedeni içeriyor. Eski ortak iş/terminal kaydında işlem türü yoksa açılış günlüğünde iş türü kullanılıyor.
- **K-5:** Kaynak beklemesi için her denemede aşama olayı yerine başlangıç, özet ve bitiş; 150 sahte denemede en çok üç olay.
- **K-6:** Başarısız atomik yazımın geçici dosyası temizleniyor. Başlangıçta yalnız kendi özel klasörlerindeki geçerli UUID desenli, hem oluşturulma hem yazılma zamanı bir saatten eski geçici dosyalar özel ACL ve açık dosya kontrolleriyle temizleniyor; hata açılışı durdurmuyor.
- **K-7:** İlk boşta belge zaman aşımı ve geçici ağ hatalarında aynı süreçte en fazla üç deneme, 1 ve 2 saniye geri çekilme; kalıcı hata önceki davranışa iletiliyor. Denemeler ve süreler günlüğe yazılıyor.

Kırmızı testler değişiklik öncesi ayrık çalışma ağacında doğrulandı: K-4 kurtarma gerekli hatası, K-5 her denemede aşama kaydı, K-6 başlangıç temizleme işlevinin yokluğu, K-7 yeniden deneme işlevinin yokluğu. K-6 başarısız yazım senaryosu testte ayrıca doğrulandı; eski kaynakta başlangıç temizliği bulunmuyordu. Yeşil testlerde gerçek yardımcı süreç geçici klasörde kilit alıp 17 koduyla çıktı ve sonraki alım kurtarıldı. Dört kilit türü, PID yeniden kullanımı, canlı/bozuk kayıt ve açılış taraması da kapsandı.

| Kapı | Sonuç |
|---|---|
| Odaklı Bun | 11 başarılı, 0 başarısız |
| Odaklı Node | 2 başarılı, 0 başarısız |
| Kök (119 dosya) | 1.234 başarılı, 5 atlanan, 0 başarısız; 7.849 assertion |
| Launcher Node | 442 başarılı, 3 atlanan, 0 başarısız |
| Launcher Bun | 45 başarılı, 0 başarısız |
| İki typecheck | Çıkış 0 |
| Sürüm | `VERSION_SYNC_OK 5.1.25 bun@1.4.0` |
| Diff denetimi | Çıkış 0 |
| Paket | `bun run app:package`, çıkış 0 |
| Gerçek paket dumanı | `PACKAGED_LAUNCHER_SMOKE_OK win32/x64`, CDP 200, runtime doğrulandı, PC hizmeti başladı |
| Gizli Chrome dumanı | `BROWSER_SMOKE_OK`, Chrome/157.0.8103.79, 111 örnek, 0 odak değişimi, 0 Chrome örneği |

Paket açılışı: ilk kaynak ve runtime toplamı 45,711 s; ikinci açılış 0,702 s; arka plan karma 3,767 s. Paket ön plan örnekleyicisi 453 örnekte 0 odak değişimi, 0 Chrome ve 0 köprü örneği gördü. Gerçek Windows soğuk yeniden başlatması ve canlı tünel/tam yetki süresi ölçülmedi; testler geçici profilde çalıştı.

Paket: `launcher/artifacts/feno-bridge-5.1.25-win-x64.exe` (162.446.209 bayt).
SHA-256: `1ffe282db9615d79ff982663a334cbe97aef35a17b86f7f0408bd31ad89a11eb` — yan dosya oluşturuldu ve yeniden karma alınarak eşleşme doğrulandı (`True`).
Paketli `pc-windows-helper.exe`: `04f313399fcfbc1c1540c5359def4789a29f547ad67c73bc646a66e98ac5b972`.
Paketli `chrome-native-host.exe`: `a01f6c9f56f080386c905b4800adb267ca4bb4e5a24ba03d167655855b584b64`.
Her iki yardımcı paket içindeki kendi `.sha256` dosyasıyla eşleşti; uzantı manifesti 5.1.25 doğrulandı.

Defender `MsMpEng` önce/sonra 1 (PID 3980); tehdit tespit kaydı sayısı 40 → 40. DEV kalıcı izin SHA-256 önce/sonra `5a19c30d19650dcb0250d61fc6e53836e356b3152f6300e620113913113e4bef`. Canlı PC2 araçları, kurulum, canlı koordinasyon/runtime, Chrome profili, DEV ve Defender ayarları değiştirilmedi. Merge, etiket ve CI bekleme yoktur.

## Devam: yayın hazırlığı (5.1.26)

19.11.2026 — PR #97, taban `9f59027`; uzak dal ile karşılaştırma 0/0. Sürüm 5.1.26 olarak eşitlendi. Sharp 0.34.5 → 0.35.5 (`^0.35.5`); kök audit sıfır bulgu, yeni istisna yok. Kilitte win32-x64, linux-x64, darwin-arm64 ve darwin-x64 yerel paketleri; Unix libvips 1.3.4 ve Windows paketine gömülü libvips mevcut. Sharp 0.35 sürüm notlarındaki Node alt sınırı, kaldırılan kurulum betiği ve eski seçenekler incelendi. Önizlemenin boyut sınırı, failOn, limitInputPixels, PNG/JPEG ve metadata davranışı değişmedi. Runtime üretim bağımlılıkları @img paketlerini kapsıyor; yer değiştirilmiş runtime ve paketli Electron içinde gerçek PNG→JPEG dönüşümü doğrulandı.

Çok platform incelemesi: Windows FFI (Job Object, Toolhelp32, ACL) tembel ve Windows koşullu yükleniyor; mevcut native test korumaları yerinde. Geçici gerçek sürücü kökü kullanılarak D:/G: bağımlılığı giderildi; macOS /var kanonik yolu karşılaştırılıyor. Test ve runtime dumanı geçici koordinasyon dizinine yönlendirildi. Temiz Windows CI için kök testlerden önce native yardımcı derleniyor. Başsız CI'da etkileşimli HWND yokluğu kabul edilir; etkileşimli ortamda odak denetimi sürer.

**Windows dışı atlamalar (yeni veya açık hale getirilen):** `pc-acceptance-515` T39 izole Chrome profili; `pc-acceptance-517` T23 Notepad mevcut/eksik dosya ve T31 Chrome handoff; `pc-full-access` sürücü kökü kapsamı, terminal/masaüstü kimlik rotasyonu, Notepad mevcut dosya ve yaşayan işin lineage rotasyonu. İlk üçü Windows tam erişim sürücü kökü ile gerçek dosya sistemi davranışını gerektirir; son dördü önceden Windows dışında erken dönüyordu. Mevcut Windows native ACL, hizmet, güvenlik deposu, tam erişim ve native broker testleri Windows koşullu kalır. Platform bağımsız mock testleri korunmuştur.

Windows koşusunda kökte beş atlama: iki Unix sembolik bağ testi (Codex config yönlendirme/geri alma), macOS dış hizmet kurulum temizliği ve iki isteğe bağlı masaüstü/ADB E2E testi. Launcher Node'da üç atlama: Linux AppImage geçici çıkarma, Linux AppImage güncelleme ve Unix shebang kullanan ilk tünel açılışı. Linux/macOS fiziksel koşusu yapılmadı; statik inceleme tamamlandı, gerçek dört platform sonucu CI ile belirlenecek.

| Ayrı kapı | Sonuç |
|---|---|
| check-version | VERSION_SYNC_OK 5.1.26 bun@1.4.0 |
| audit | 145 paket, sıfır bulgu |
| launcher:audit | 351 paket, mevcut minimatch istisnası dışında sıfır bulgu |
| typecheck / launcher:typecheck | Çıkış 0 |
| Kök Bun testleri | 1.234 başarılı, 5 atlanan, 0 başarısız; 7.849 assertion, 119 dosya |
| Launcher Node / Bun | 442 başarılı, 3 atlanan / 45 başarılı, 0 başarısız |
| launcher:build | Çıkış 0 |
| Runtime bundle ve notices | Çıkış 0; 114 paket bildirimi |
| smoke-release | Çıkış 0; SHARP_RUNTIME_OK 0.35.5 8.18.7; RELOCATABLE_RUNTIME_SMOKE_OK |
| app:package | EXE ve blockmap üretildi, SHA-256 eşleşti |
| app:smoke | Çıkış 0; PACKAGED_SHARP_OK 0.35.5 8.18.7; PACKAGED_LAUNCHER_SMOKE_OK win32/x64, CDP 200 |
| Gizli Chrome dumanı | Çıkış 0; BROWSER_SMOKE_OK Chrome/157.0.8103.79, 125 örnek, 0 odak değişimi |
| git diff --check | Çıkış 0 (satır sonu uyarıları dışında bulgu yok) |

İlk kök koşudaki altı fixture hatası geçici sürücü köküyle düzeltildi; son koşu sıfır başarısız. PowerShell 5.1 stderr yönlendirmesi kök test ve paket sarmalayıcısında NativeCommandError/çıkış 1 üretti; Bun sonuç özeti ve electron-builder tamamlanma çıktısı ile gerçek paket, karma ve açılış bağımsız doğrulandı. İlk paket dumanı zaten ön planda olan canlı köprüyü yanlış pozitif saydı (479 örnek, sıfır HWND/PID değişimi). Örnekleyici başlangıç HWND/PID'sini yeni odak alımından ayıracak şekilde düzeltildi. Son gerçek paket dumanında 497 örnek, 0 odak değişimi, 0 yeni Chrome ve 0 yeni köprü örneği; ilk runtime açılışı 48,695 s, ikinci 0,893 s.

Paket: `launcher/artifacts/feno-bridge-5.1.26-win-x64.exe` (162.968.770 bayt); SHA-256 `4cab979504455dbeda89dde9fb0779b417da56e7120e062bda9aa0e09e95164c`. Yan .sha256 dosyası yeniden karma ile eşleşti. Paketli Windows helper SHA-256 `ef1cd5ff78bf4601ccf78ccc0ce1c5e91b87015155f2f8b6ad392cb71838e63e`, Chrome native host `9596107a037f2efd44fcc0f4329c9802c2568ed11486d780aca90efb97916663`; native derlemenin ürettiği güncel yardımcı karma dosyası izlendi. Paket kurulmadı.

Değişen dosyalar: `README.md`, `README.ja.md`, `README.ko.md`, `README.zh-CN.md`, `package.json`, `bun.lock`, `launcher/package.json`, `launcher/chrome-extension/manifest.json`, `launcher/electron/pc-windows-helper.sha256`, `launcher/scripts/smoke-package.cjs`, `launcher/tests/chrome-worker.test.cjs`, `launcher/tests/runtime-install.test.cjs`, `scripts/install.sh`, `scripts/smoke-release.ts`, `scripts/verify.ts`, `src/version.ts`, `src/pc-control/screenshot-widget.ts`, `src/pc-control/widget-probe.ts`, `tests/pc-acceptance-515.test.ts`, `tests/pc-acceptance-516.test.ts`, `tests/pc-acceptance-517.test.ts`, `tests/pc-full-access.test.ts`, `tests/pc-mcp-core.test.ts`, `tests/pc-security-authorization.test.ts`, `tests/support/isolate-homes.ts` ve bu rapor.

Defender tehdit tespit kaydı 40 → 40; DEV kalıcı izin SHA-256 `5a19c30d19650dcb0250d61fc6e53836e356b3152f6300e620113913113e4bef` değişmedi. Canlı PC2 araçları kullanılmadı; canlı kurulum, profiller, izinler, tüneller ve diğer çalışma ağaçları kapsam dışı kaldı. PR #97 taslak kalacak; merge, etiket, yayın ve CI bekleme yok.

### CI turu 2

19.11.2026 — Taban `33da3ff`, uzak dal farkı 0/0; sürüm 5.1.26. CI 44497817881 günlüklerinde Windows'ta 35 kök hatası, Linux/macOS'ta üç launcher hatası incelendi.

**B1:** `canonical-temp.ts` ile testlerin gerçek geçici dizin yolları `realpathSync.native` üzerinden eşitlendi. Üretimde `paths.ts` hem izinli kökü hem mevcut hedefi (yeni dosya için üst dizini) kanonikleştiriyor; `project-file-native.ts` açık dizin tanıtıcıları, gerçek dizin kimlikleri ve kanonik sınır ile kontrolü sürdürüyor. Üretim sınırı değiştirilmedi. Yeni 8.3 testi kısa ve uzun kökten okuma, kısa kökten oluşturma ve kardeş dizin/junction reddini doğruladı.

**B2:** `private-acl-native.cjs` artık SDDL metnini değil, GetAclInformation/GetAce ile gerçek ACE'leri ve tam SID değerlerini karşılaştırıyor. Korumalı DACL, sahip, yalnız izin ACE'si, tam erişim maskesi, tam kullanıcı/SYSTEM/Administrators kümesi, dizin OICI ve dosyada sıfır bayrak koşulları korundu. RID-500 örneği ve Windows API ile açılan gerçek LA takma adı yerel regresyon testinde geçti; hatalı sahip, hak, bayrak, trustee, tür ve ACE sayısı reddedildi. CI hesabının gerçekten RID-500 olduğu henüz doğrudan ölçülmedi; eski metin karşılaştırmasının LA durumunda bozulduğu doğrulandı. CI için kimlik içermeyen ACL neden kodları eklendi. TS tarafında eşdeğer SDDL metin karşılaştırması bulunmadı.

**35 Windows hatasının eşlemesi** (`windows-fail-list.txt` sırası; tümü son yerel kök koşusunda geçti):

| No | Test | Düzeltme |
|---|---|---|
| 1 | Chrome upload holds native read boundaries | B1 pc-files |
| 2 | T39: full-access Notepad filePath | B1 pc-acceptance-515 |
| 3 | a compatible DEV record | B2 ACL |
| 4 | a machine with no DEV home or peer | B2 ACL |
| 5 | a stopped legacy DEV home or install | B2 ACL |
| 6 | an elapsed waiting deadline | B2 ACL |
| 7 | asynchronous revocation cleanup failure | B2 ACL |
| 8 | crash releases the OS handle | B2 ACL (kilit edinimi) |
| 9 | create never overwrites | B1 pc-files |
| 10 | create publishes complete bytes | B1 pc-files |
| 11 | failed replacement leaves no stage | B2 ACL |
| 12 | full access Notepad accepts an approved existing file | B1 pc-full-access |
| 13 | live DEV overrides retirement | B2 ACL |
| 14 | local recovery cannot clear a live owner | B2 ACL |
| 15 | locally verified retired DEV home | B2 ACL |
| 16 | malformed legacy or private DEV evidence | B2 ACL |
| 17 | missing LOCALAPPDATA | B2 ACL |
| 18 | missing, invalid and legacy peer evidence | B2 ACL |
| 19 | new files and directories have an explicit private Windows ACL | B2 ACL |
| 20 | no DEV home, installation or live process | B2 ACL |
| 21 | patch preserves CRLF semantics | B1 pc-files |
| 22 | patch preserves LF semantics | B1 pc-files |
| 23 | patch preserves empty file semantics | B1 pc-files |
| 24 | patch preserves mixed endings semantics | B1 pc-files |
| 25 | patch preserves no final newline semantics | B1 pc-files |
| 26 | permanent lineage survives heartbeat and key rotation | B2 ACL |
| 27 | portable Akentek DEV install root | B2 ACL |
| 28 | release waits for real completion | B2 ACL |
| 29 | revocation is irreversible by replaying an earlier signed grant | B2 ACL |
| 30 | signed local approval drives real MCP files | B2 ACL |
| 31 | signed private state authorizes only its own profile | B2 ACL |
| 32 | stale heartbeat, rotated key and expired signed approval | B2 ACL |
| 33 | two actual Windows processes racing across profiles | B2 ACL |
| 34 | unknown process result and live legacy descriptor | B2 ACL |
| 35 | wait cancellation, bounded timeout and grant revocation | B2 ACL |

**B3 ve Linux/macOS:** İki heartbeat yarış testi gerçek platforma uygun geçici dizin kullanır; native helper hata dönüşümü saf `parseNativeResult` ayrıştırıcısıyla üç platformda test edilebilir. Üretimin native Windows güvenlik sınırı korunur; Windows dışında fail-closed testi eklendi. Üç eski başarısız test kapatılmadı, yerel odaklı koşuda 3/3 geçti. Launcher yolu karşılaştırmaları ve ACL testleri ayrıca tarandı: `pc-service.cjs` zaten native kanonik kök kullanıyor; `private-acl.test.cjs` icacls çıktısındaki LA/LG dahil gerçek SID'leri doğruluyor. Başka doğrudan kısa yol/metin SID hatası saptanmadı.

Yerel atlamalar: kökte önceki beş (iki Unix sembolik bağ, macOS temizlik ve iki isteğe bağlı masaüstü/ADB E2E); launcher Node'da önceki üç (iki Linux AppImage, Unix shebang tünel başlangıcı) ve yeni Windows dışı fail-closed testi. 8.3 testi bu Windows koşusunda atlanmadı; kısa ad bulunmayan dosya sisteminde veya Windows dışında atlanır. Native ACL testleri Windows dışında koşmaz. Yeni üç platform bağımsız launcher regresyonu korunur.

| Ayrı doğrulama kapısı | Sonuç |
|---|---|
| check-version | VERSION_SYNC_OK 5.1.26 bun@1.4.0 |
| audit | 145 paket, sıfır bulgu |
| launcher:audit | 351 paket, mevcut bir istisna dışında sıfır bulgu |
| Kök typecheck / launcher:typecheck | Çıkış 0 |
| Kök Bun | 1.235 başarılı, 5 atlanan, 0 başarısız; 7.861 assertion, 119 dosya |
| Launcher Node / Bun | 442 başarılı, 4 atlanan / 46 başarılı, 0 hata |
| Launcher build | Çıkış 0 |
| Runtime bundle / notices | Çıkış 0, 114 paket bildirimi |
| smoke-release | SHARP_RUNTIME_OK 0.35.5 8.18.7; RELOCATABLE_RUNTIME_SMOKE_OK |
| app:package | Çıkış 0, EXE ve blockmap üretildi |
| app:smoke | PACKAGED_LAUNCHER_SMOKE_OK win32/x64; CDP 200; PACKAGED_SHARP_OK 0.35.5 8.18.7 |
| Gizli sekme | BROWSER_SMOKE_OK Chrome/157.0.8103.79; 97 örnek, 0 odak değişimi, 0 Chrome örneği |
| git diff --check | Çıkış 0; yalnız Git çalışma kopyası satır sonu uyarıları |

Önceki kesilen süreç kimlikleri yeniden bağlanamadığından kök ve runtime koşuları yeniden yapıldı; son koşuların gerçek çıkış kodları 0. PowerShell stderr yönlendirme uyarıları Bun'un gerçek çıkış kodunu değiştirmedi. Paket dumanı: 482 ön plan örneği, sıfır odak değişimi, sıfır yeni Chrome ve köprü örneği. İlk runtime kaynak/kurulum 45,401 s, ikinci 0,840 s. Gerçek açılış dumanında geçici çıkarılmış paket kullanıldı; kullanıcıya kurulum yapılmadı.

Yeni paket `launcher/artifacts/feno-bridge-5.1.26-win-x64.exe` (162.969.814 bayt). SHA-256: `6365ffd3505ebd6f31bd4505fc78a09e37426188b2ee1257851e4667476a1cae`; `.sha256` yeniden alınan karma ile eşleşti. Paket içinde Windows helper `46aa5354522b5ecd023bbf0d962f849a83a17eac75dc8b3ed50297d45ecfc073`, Chrome native host `0bfd6c94477c4ac18eefb64e2b6347d6cc70f73312c9ba31e6e813c25bc02252` doğrulandı.

Değişen dosyalar: `launcher/electron/private-acl-native.cjs`, `launcher/electron/private-acl.cjs`, `launcher/electron/pc-windows-helper.sha256`, `launcher/tests/pc-consent-channel-race.test.cjs`, `launcher/tests/private-acl.test.cjs`, `launcher/tests/private-helper-errors.test.cjs`, `tests/pc-acceptance-515.test.ts`, `tests/pc-files.test.ts`, `tests/pc-full-access.test.ts`, `tests/support/canonical-temp.ts` ve bu rapor.

Defender tehdit tespit sayısı 40 → 40. DEV kalıcı izin SHA-256 `5a19c30d19650dcb0250d61fc6e53836e356b3152f6300e620113913113e4bef` değişmedi. Canlı PC2 araçları kullanılmadı; kurulum, canlı izin/profil/runtime ve diğer çalışma ağaçları değiştirilmedi. Linux/macOS ve Windows runner'daki yeni CI sonucu henüz doğrulanmadı; CI beklenmeyecek. PR #97 taslak kalacak, merge/etiket/yayın yapılmayacak.

### CI turu 3

19.11.2026 — Taban `fb455a8`, uzak dal farkı 0/0; sürüm 5.1.26. CI 44505893356'da önceki ACL hataları kayboldu; Windows'ta tek 8.3 beklentisi, Linux/macOS'ta libvips lisans bildirimi kaldı.

**Lisanslar:** Linux x64, Darwin arm64 ve Darwin x64 için npm tarball'ları kurulum yapmadan indirildi ve dosya listeleri ile package.json alanları incelendi. Üçünün de sürümü 1.3.4, lisansı LGPL-3.0-or-later; LICENSE/COPYING/NOTICE yok. Kilit dosyasındaki diğer yedi libvips platformu da npm pack --dry-run ile denetlendi; aynı lisans ve eksiklik doğrulandı. Sharp native sarmalayıcılarının tümü LICENSE taşıyor; Windows'un üç mimarisinde Apache-2.0 AND LGPL-3.0-or-later. Sharp ve @img/colour lisans dosyaları mevcut.

- `LICENSES/libvips-LGPL-3.0.txt` (7.652 bayt): https://www.gnu.org/licenses/lgpl-3.0.txt
- `LICENSES/libvips-GPL-3.0.txt` (35.149 bayt): https://www.gnu.org/licenses/gpl-3.0.txt

GNU'nun tam lisans metinleri indirildi; LGPL'nin atıf yaptığı GPL metni de eklendi. Bildirim üreticisi on libvips 1.3.4 kimliğini ve üç Windows native 0.35.5 kimliğini açıkça eşliyor, mevcut paket lisanslarını koruyor ve iki GNU metnini ekliyor. Bilinmeyen sürümde eksik lisans veya eksik override dosyası hâlâ hata. Regresyon testi 13 kimliği, özgün Windows LICENSE metninin korunmasını ve bilinmeyen sürümün reddini doğruladı (46 assertion). Runtime/launcher LICENSES kopyalama deseni iki dosyayı paketliyor; release.yml ayrı, benzersiz adlarla yayın varlıklarına kopyalıyor; mevcut flatten/checksum adımları aynen kaldı. Bu çalışma eksik lisans bildirimi hatasının onarımıdır; bütün gömülü bileşenlerin ayrı bir lisans uyum denetimi değildir.

**8.3:** `tests/pc-mcp-core.test.ts` içindeki signed local approval akışı artık `canonicalTemp` kullanıyor; iş geçmişindeki projectRoot beklentisi native kanonik yol ile eşleşiyor. Kök ve launcher tmpdir kullanımları, dönen yol karşılaştırmaları, runtime ve paket smoke yolları tarandı. Doğrudan kanonik yol karşılaştırması gerektiren ek hata bulunmadı; önceki 8.3 sınır testi korundu. Yeni test atlaması yok.

| Ayrı doğrulama kapısı | Sonuç |
|---|---|
| check-version | VERSION_SYNC_OK 5.1.26 bun@1.4.0 |
| audit | 145 paket, sıfır bulgu |
| launcher:audit | 351 paket, mevcut bir istisna dışında sıfır bulgu |
| Kök typecheck / launcher:typecheck | Çıkış 0; son lisans genişletmesinden sonra kök typecheck tekrar geçti |
| Kök Bun | 1.236 başarılı, 5 atlanan, 0 başarısız; 7.878 assertion, 120 dosya |
| Son lisans regresyonu | 1 başarılı, 0 başarısız; 46 assertion (ek platform eşlemelerinden sonra) |
| Launcher Node / Bun | 442 başarılı, 4 atlanan / 46 başarılı, 0 hata |
| Launcher build | Çıkış 0 |
| Runtime bundle / notices | Çıkış 0, 114 paket bildirimi |
| smoke-release | SHARP_RUNTIME_OK 0.35.5 8.18.7; RELOCATABLE_RUNTIME_SMOKE_OK |
| licenses | Çıkış 0, 114 paket bildirimi |
| app:package | Çıkış 0; EXE ve blockmap üretildi |
| app:smoke | PACKAGED_LAUNCHER_SMOKE_OK win32/x64; CDP 200; PACKAGED_SHARP_OK 0.35.5 8.18.7 |
| Gizli sekme | BROWSER_SMOKE_OK Chrome/157.0.8103.79; 97 örnek, 0 odak değişimi, 0 Chrome örneği |
| git diff --check | Çıkış 0; mevcut Git satır sonu uyarıları |

Paket açılış dumanı 463 ön plan örneğinde sıfır odak değişimi, sıfır Chrome ve köprü örneği gösterdi. İlk ve ikinci runtime kaynak/kurulum süreleri sırasıyla 45,579 s ve 0,787 s. Yeni paket `launcher/artifacts/feno-bridge-5.1.26-win-x64.exe` (162.993.710 bayt), SHA-256 `a8219ca0311693f2ea415691735f15d74c91ce29e950cc43b574b074f132c9fc`; `.sha256` dosyası yeniden hesaplanan karma ile eşleşti. Paket helper SHA-256 `0d24e31b9649d366f96367ee85ee418a97f947e72fa10662febe442efc443bd7`, native host SHA-256 `0ce213ad12a28cdc9cbe43dc08cc67275a7cb8a8bad416f857ad690b836c35af` doğrulandı.

Değişen dosyalar: `.github/workflows/release.yml`, `scripts/generate-third-party-notices.ts`, iki GNU lisans dosyası, `tests/pc-mcp-core.test.ts`, `tests/third-party-notices.test.ts`, `launcher/electron/pc-windows-helper.sha256` ve bu rapor. Defender 40 → 40; DEV kalıcı izin SHA-256 `5a19c30d19650dcb0250d61fc6e53836e356b3152f6300e620113913113e4bef` değişmedi. Canlı araç, kurulum, merge, etiket ve yayın yok. Linux/macOS gerçek runner doğrulaması yeni CI koşusuna kalıyor; CI beklenmeyecek, PR #97 taslak kalacak.

### Eski widget adresi uyumluluğu

19.11.2026 — Taban `26c6abd`, uzak dal farkı 0/0; sürüm 5.1.26. ChatGPT'nin önbellekteki `ui://widget/pc-screenshot-v5.1.23.html` isteği önce yeni regresyon testinde -32602 üretti. SDK'nın URL normalleştirmesi nedeniyle ham URI, mevcut kaynakların kayıtlı okuma işlevlerine güvenli bir MCP `resources/read` işleyicisiyle eşleniyor. Dört kaynak ailesinin güncel HTML, MIME ve CSP dahil metadata'sı aynen korunuyor; yanıtta URI istenen adres. Kaynak ve araç listeleri eski adresleri duyurmuyor. Ekran görüntüsü aracı ve HTML davranışında değişiklik yok.

Kabul: `ui://widget/pc-screenshot-v5.1.23.html`, `ui://widget/pc-screenshot-skybridge-v5.0.96.html`, `ui://widget/probe-mcpapp-v5.1.23.html`, `ui://widget/probe-skybridge-v5.0.96.html`; her dört ailede iki eski sürüm ve güncel sürüm test edildi. Sayısal üç bileşen en fazla üç basamak ve güncel sürümden büyük olamaz. Ret (-32602): boş sürüm, `5.1`, `5.1.26.1`, `5.1.27`, `9.9.9`, `0000.1.1`, `../`, yüzde kodlaması, sorgu, fragment, yanlış harf büyüklüğü, boşluk ve satır sonu. Nokta segmentleriyle güncel adrese normalleşebilen istekler de reddediliyor.

Değişen dosyalar: `src/pc-control/mcp-tools.ts`, yeni `tests/pc-widget-legacy-uri.test.ts`, mevcut testlerin sunucu taklitleri (`tests/pc-browser.test.ts`, `tests/pc-full-access.test.ts`, `tests/pc-mobile-diagnostics.test.ts`, `tests/pc-screenshot-widget.test.ts`, `tests/pc-widget-probes.test.ts`), yeniden üretilen `launcher/electron/pc-windows-helper.sha256` ve bu rapor.

| Ayrı doğrulama kapısı | Sonuç |
|---|---|
| Regresyon kırmızı → yeşil | Önce -32602; düzeltme sonrası ilgili 18 test, 251 assertion, 0 hata |
| check-version | VERSION_SYNC_OK 5.1.26 bun@1.4.0 |
| audit | 145 paket, sıfır bulgu |
| launcher:audit | 351 paket, mevcut bir istisna dışında sıfır bulgu |
| typecheck / launcher:typecheck | Çıkış 0 |
| Kök Bun | 1.237 başarılı, 5 atlanan, 0 başarısız; 8.012 assertion, 121 dosya |
| Launcher Node / Bun | 442 başarılı, 4 atlanan / 46 başarılı, 0 hata |
| launcher:build | Çıkış 0 |
| Runtime bundle / notices | Çıkış 0, 114 paket bildirimi |
| smoke-release | SHARP_RUNTIME_OK 0.35.5 8.18.7; RELOCATABLE_RUNTIME_SMOKE_OK |
| licenses | Çıkış 0, 114 paket bildirimi |
| app:package | Çıkış 0; EXE ve blockmap üretildi |
| app:smoke | PACKAGED_LAUNCHER_SMOKE_OK win32/x64; CDP 200; PACKAGED_SHARP_OK 0.35.5 8.18.7 |
| Gizli sekme | BROWSER_SMOKE_OK Chrome/157.0.8103.79; 101 örnek, 0 odak değişimi, 0 Chrome örneği |
| git diff --check | Çıkış 0; Git'in mevcut LF/CRLF uyarıları |

Paket `launcher/artifacts/feno-bridge-5.1.26-win-x64.exe` (162.993.890 bayt), SHA-256 `998d10eab71815fd2f705ad6d2891d853c872f62afe0040d1a5f349f55698e4c`; `.sha256` eşleşmesi True. Paket açılış dumanı 447 ön plan örneğinde 0 odak değişimi, 0 Chrome ve 0 köprü örneği gösterdi. Paket helper SHA-256 `b9a895486aa94069f86e3046fd26479eb1e79a515f10a970c54c80c0a0235160`, Chrome native host SHA-256 `fa294df218dffb399320fcf3220eea2be72239d9d1af3ec2821421a34eb88ac7` doğrulandı. Defender 40 → 40; DEV kalıcı izin SHA-256 `5a19c30d19650dcb0250d61fc6e53836e356b3152f6300e620113913113e4bef` değişmedi. Yeni test atlaması yok. Canlı araç kullanılmadı, kurulum yapılmadı. Gerçek ChatGPT önbellek davranışı yeni paket kurulmadan canlı doğrulanmadı; regresyon testi gerçek MCP SDK istemci/sunucu bağlantısıyla çalıştı. Çok platformlu CI sonucu beklenmeyecek; PR #97 taslak kalacak.

### Runtime gömülü yol (kritik)

5.1.26, başlangıç `7b71d02`; origin ile fark başlangıçta 0/0. Canlı kurulu eski `versions/5.1.26-win32-x64/app/cli.js` ve eski derleme yalnız okunarak incelendi. Bun, `private-acl.cjs` içindeki `__dirname` değerini `D:\\GitHub\\feno-bridge-pc-normal-next\\launcher\\electron` olarak JS içine gömüyordu. Bir ayrıntı: eski Bun eşzamanlı ve asenkron yolları `process.versions.bun` dalında gömülü `private-acl-native.cjs` modülünü süreç içinde çalıştırıyordu; kaynak betiği çağrısının canlı gerçekleştiği doğrulanmadı. Gömülü kaynak yolu Node/Electron alt süreç dalına aitti ve Linux/macOS taşıma dumanını kırıyordu. Windows ham yol taraması JS kaçışlı yolu görmüyordu.

Yeni paket `runtime/private-acl-cli.cjs`, `runtime/private-acl-native.cjs` ve `runtime/private-atomic-retry.cjs` dosyalarını içerir. Üçü de schema 2 manifestinde boyut ve SHA-256 ile yer alır; mevcut bundleId ve kurulum makbuzu üç dosyayı da kapsar. Makbuz testinde yardımcı dosya bozulduğunda arka plan doğrulaması başarısız olur ve makbuz geçersizleşir. Paketlenmiş Bun, gerçek `app/cli.js` ve gömülü Bun çalıştırıcısının aynı runtime kökünde olduğunu doğrular; mutlak, bağlantısız ve kanonik yolları kabul eder, üç dosyanın manifest karması ile derlemeye sabitlenmiş karma değerlerini karşılaştırır. Ardından doğrulanmış yardımcı betiği çalıştırır. Node/Electron `module.filename` üzerinden asar.unpacked yolunu çalışma anında çözer. Kaynak Bun testleri ve süreç içinde kalması gereken native kilit işlemleri mevcut davranışı korur. Paketlenmiş ACL çağrıları için alt süreç maliyeti vardır; yoğun canlı kullanım gecikmesi ayrıca ölçülmedi.

Kırmızı-yeşil: yeni tarayıcı eski `dist/runtime/app/cli.js` için `Runtime artifact embeds an ephemeral build path` hatasını üretti. Yeni paketin tüm JS/CJS/MJS ve CMD dosyaları ham, JS kaçışlı, eğik çizgili yasak yollar ve sabit `var __dirname`/`var __filename` desenleriyle tarandı; sonuç temiz. İki regresyon testi asar, asar.unpacked, runtime, göreli/kök dışı yol, junction, bozuk yardımcı ve değiştirilmiş manifest reddini kapsıyor. Taşınan runtime'da gerçek ACL oluşturma, yazma, okuma ve silme çalıştı: `RELOCATED_ACL_HELPER_OK .../relocated-runtime/runtime/private-acl-cli.cjs`. EXE'den izole dumanla kurulan kopyada da `PACKAGED_ACL_HELPER_OK .../core-home/versions/5.1.26-win32-x64/runtime/private-acl-cli.cjs` alındı; o kopyanın JS taraması temiz. Canlı eski kurulum değiştirilmedi.

| Kapı (ayrı süreç) | Sonuç |
|---|---|
| check-version | VERSION_SYNC_OK 5.1.26, Bun 1.4.0 |
| audit | 145 paket, sıfır bulgu |
| launcher:audit | 351 paket, sıfır bulgu; mevcut bir istisna |
| typecheck / launcher:typecheck | İkisi de çıkış 0 |
| bun test ./tests | 1237 başarılı, 5 atlama, 0 hata; 1242 test, 121 dosya |
| launcher testleri | Node 444 başarılı, 4 atlama, 0 hata; Bun 46 başarılı, 0 hata |
| launcher:build | Çıkış 0 |
| runtime bundle | Çıkış 0; son paket runtime'ı da yeniden derlendi |
| third-party notices / licenses | Çıkış 0, 114 paket bildirimi |
| smoke-release | SHARP_RUNTIME_OK 0.35.5 8.18.7; RELOCATED_ACL_HELPER_OK; RELOCATABLE_RUNTIME_SMOKE_OK (son paket runtime'ı dahil) |
| app:package | Çıkış 0; EXE ve blockmap üretildi |
| app:smoke | PACKAGED_ACL_HELPER_OK; PACKAGED_SHARP_OK; PACKAGED_LAUNCHER_SMOKE_OK; CDP 200, runtimeVerified ve pcServiceStarted true |
| Gizli sekme | BROWSER_SMOKE_OK; 93 örnek, 0 odak değişimi, 0 Chrome örneği |
| git diff --check | Çıkış 0; mevcut LF/CRLF uyarıları |

Paket `launcher/artifacts/feno-bridge-5.1.26-win-x64.exe` (163.002.746 bayt), SHA-256 `e77be63f76a31eed23f54b8ca48262e58526777a856925be235a46556c5e0e85`; `.sha256` eşleşmesi True. Paket dumanı 454 ön plan örneğinde 0 odak değişimi, 0 Chrome ve 0 köprü örneği; ilk kaynak ve kurulum 46,768 s, ikinci 0,820 s. Windows helper SHA-256 `bb617e46c18dfc7bbe1b82daa619ae60eae5a0748850efb06e8bf06bf9fb10b4`, Chrome native host SHA-256 `be4cab7b840f9d2c436798b57e81637d6f9950e6a05e61ae48eba57b19f81ab4` doğrulandı. Defender 40 → 40; DEV kalıcı izin SHA-256 `5a19c30d19650dcb0250d61fc6e53836e356b3152f6300e620113913113e4bef` değişmedi.

Değişen dosyalar: `launcher/electron/private-acl.cjs`, `private-acl-cli.cjs`, yeni `private-acl-location.cjs`, `pc-windows-helper.sha256`, `launcher/tests/private-acl-location.test.cjs`, `launcher/tests/runtime-install.test.cjs`, `launcher/scripts/smoke-package.cjs`, `scripts/build-runtime-bundle.ts`, yeni `scripts/runtime-path-audit.cjs`, `scripts/smoke-release.ts`, `src/cli.ts` ve bu rapor. Yeni test atlaması yok. Canlı PC2/Chrome araçları, canlı kurulum, canlı koordinasyon/runtime, DEV, Defender ayarları ve başka worktree'ler değiştirilmedi. Linux/macOS gerçek runner sonucu CI'da doğrulanacak; bu turda CI bekleme, merge, etiket, yayın veya PR'ı hazır yapma yok.
