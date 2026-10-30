# Akentek PC Bridge — Feno Bridge Üzerinden Tam PC Kontrolü

Durum: **Onaylanmış tasarımın arşiv kopyası; uygulama `feat/akentek-pc-bridge` dalında, dağıtım ayrıca onaylanacak**  
Tarih: 30 Ekim 2026  
Hedef depo: `Ahmet1991/feno-bridge`  
Mevcut kaynak sürümü: `5.0.94` (ev PC'sindeki kurulu sürüm henüz doğrulanmadı)

## 1. Amaç

Ahmet Can'ın ChatGPT sohbetinden, Codex görevi başlatmadan, evdeki Windows PC'de yetkili işlemleri yapabilmek: dosya ve proje inceleme/düzenleme, terminal, Git, GitHub self-hosted runner, Android TV emülatörü, ekran görme, fare ve klavye, test-tekrar düzeltme döngüsü. iPhone'dan başlayan bir sohbet aynı bağlantıyı kullanabilmeli.

Mevcut Feno Bridge, ChatGPT oturumu, Codex model yönlendirmesi, `Codex Native2` sözleşmesi ve GitHub CI işleyişi korunacak. Canlıya dağıtım kullanıcı onayı olmadan yapılmayacak.

## 2. İncelemeyle doğrulanan mevcut yapı

- `README.md`: Full harness modu resmi `openai/tunnel-client` ve `Codex Native2` bağlayıcısıyla çalışıyor.
- `src/tunnel.ts`: Tünel profiline stdio MCP komutu bağlanıyor: çalışma zamanı `mcp --contract native --broker-socket ...`.
- `src/adapters/chatgpt-web/mcp-server.ts`: MCP araç kayıtları ve broker'a bağlama burada. Mevcut `codex_*` araçları geçerli bir `turn_token` isteyerek aktif Codex görevi içinde çalışıyor.
- `src/adapters/chatgpt-web/turn-broker.ts`: Görev ve yetki bağları burada; bağımsız PC kontrolü için token kontrolünü atlatmak **yok**.
- `docs/security-model.md`: Yetki, çalışma alanı ve onaylar Codex tarafından veriliyor. Yeni PC araçları için ayrı yetkilendirme zorunlu.
- ChatGPT araç envanterinde `Codex Native2` ve `Codex Native2 Kanal2` mevcut. Ev PC'sindeki süreç sağlığı, canlı bağlantı ve kurulu sürüm henüz doğrulanmadı.
- GitHub tarafında `Ahmet1991/AkentekIPTV` deposu erişilebilir; `akentek-iptv-web-deploy` adlı yolun uzaktaki karşılığı ve `fenotip-tv` runner'ın güncel durumu yerel kontrol sırasında teyit edilmeli.

Kaynaklar: [Feno Bridge](https://github.com/Ahmet1991/feno-bridge), [Mimari](https://github.com/Ahmet1991/feno-bridge/blob/main/docs/architecture.md), [Güvenlik](https://github.com/Ahmet1991/feno-bridge/blob/main/docs/security-model.md), [OpenAI Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels).

## 3. Değerlendirilen yaklaşımlar ve karar

1. **GitHub runner üzerinden her şeyi yapmak:** Mevcut CI için iyi; anlık masaüstü kontrolü ve interaktif testlerde sınırlı. Ana yaklaşım değil.
2. **Yeni bağımsız tünel ve MCP:** Güvenlik sınırı yalın, ancak ikinci bağlantı, kimlik ve yaşam döngüsü yönetimi gerektiriyor. Kullanıcı mevcut düzene devam etmek istediği için seçilmedi.
3. **Mevcut Feno Bridge MCP sunucusunu genişletmek — seçildi:** `Codex Native2` sözleşmesini değiştirmeden aynı stdio MCP hizmetine ayrı, adlandırılmış `pc_*` araçları eklemek. Yeniden kullanılacak tünelin ve connector'ın gerçek oturumda uyumluluğu doğrulanmalı. Mevcut Codex araçları eskisi gibi turn-scoped kalacak.

## 4. Mimari ve bileşenler

```
ChatGPT web/iPhone
    -> mevcut Codex Native2 / OpenAI Secure MCP Tunnel
    -> Feno Bridge MCP stdio sunucusu
       -> codex_* : mevcut turn_token ile mevcut Codex broker
       -> pc_*    : yeni bağımsız PC izin denetimi
                    -> Windows kullanıcı oturumu aracısı
                    -> dosya/komut/uzun iş kuyruğu
                    -> ADB ve Android emülatör
                    -> Git/GitHub runner gözlemi
```

MCP sunucusunun ömrü, Feno launcher ve tunnel-client durumuna bağlıdır. Windows GUI işlemleri, Windows servislerinin izole Session 0 ortamı yerine kullanıcının açık ve kilitsiz interaktif oturumunda çalışır. Kilitli ekran, UAC güvenli masaüstü ve işletim sistemi izinleri aşılmaz.

Kod bölümü önerisi:

- `src/adapters/chatgpt-web/mcp-server.ts`: Sadece `pc_*` kayıtları ve ayrı modüle yönlendirme; mevcut `codex_*` alanı geriye uyumlu kalacak.
- `src/pc-control/authorization.ts`: İzin, çalışma alanı ve yerel kullanıcı onayı.
- `src/pc-control/files.ts`, `commands.ts`, `jobs.ts`: Dosyalar, komutlar ve asenkron işler.
- `src/pc-control/windows.ts`, `android.ts`, `runner.ts`: Masaüstü, ADB/emülatör ve runner.
- Launcher ayarları: “PC kontrolü” varsayılan **kapalı**, acil durdurma, izin kapsamı ve günlük durumu.
- `src/chatgpt-session.ts`: **Dokunulmayacak.**

## 5. MCP araçları (ilk sürüm)

| Araç | Amaç | Kontrol |
| --- | --- | --- |
| `pc_status` | PC/launcher/runner/emülatör bağlantı ve sürüm durumu | Salt okunur |
| `pc_list_projects`, `pc_list_files`, `pc_read_file` | İzinli çalışma kökleri ve içerikleri | Salt okunur |
| `pc_git_status` | Branch, değişen dosyalar, son commit | Salt okunur |
| `pc_write_patch` | Proje içindeki metin dosyalarını güvenli diff ile düzenleme | Yazma izni |
| `pc_start_job`, `pc_job_status`, `pc_job_logs`, `pc_cancel_job` | Sınırlandırılmış test/build komutları | İş tipine göre |
| `pc_capture_screen`, `pc_list_windows` | Gerçek masaüstü ve uygulama pencereleri | Görüntüleme izni |
| `pc_click`, `pc_key`, `pc_type`, `pc_activate_window` | Gerçek GUI kontrolü | Etkileşim izni |
| `pc_adb_devices`, `pc_adb_input`, `pc_adb_screencap` | Android TV emülatöründe kontrol ve gözlem | ADB kapsamı |
| `pc_runner_status`, `pc_runner_job_status` | Mevcut GitHub runner ve test işlerini gözleme | Varsayılan salt okunur |

İlk sürümde keyfî yönetici komutu, sistem genelinde dosya silme, sırların okunması veya onaysız prod deploy aracı olmayacak. Genel terminal yetkisi istenirse ayrıca izin profili ve kullanıcı onayı gerekir.

## 6. Yetki ve güvenlik

- Feno'nun mevcut `codex_*` token/broker kontrolleri **asla gevşetilmeyecek**. Yeni `pc_*` akışı tamamen ayrı yetki kararı verecek.
- ChatGPT connector'ının mevcut “Authentication: None / Allow all actions” ayarları tek başına PC yetkilendirmesi sayılmayacak. Yerel Windows launcher'ında kullanıcı **PC erişimini etkinleştirmeli**; süreli izin (örn. 2 saat), proje kökleri ve yetkiler açıkça gösterilmeli.
- İlk açılışta ve yeni hassas kapsamda Windows kullanıcı oturumunda onay; çıkış/kilit/erişim iptali durumunda aktif kontrol duracak. Kritik silme, kimlik bilgisi, güvenlik ayarı, canlıya yayınlama ayrı onay gerektirecek.
- Yol çözümlemesi gerçek dizine göre yapılacak; `..`, symlink/junction veya başka sürücü üzerinden izinli kök dışına kaçış reddedilecek. `D:\\GitHub` varsayılan değil, PC'de doğrulandıktan sonra izinli kök olarak seçilebilir.
- Araç çıktıları, ekran görüntüleri ve loglar giriş olarak güvensiz kabul edilecek; gizli bilgi maskeleme, sınırlı kayıt, hız sınırı, boyut ve zaman aşımı uygulanacak.
- Tehlikeli komutlarda ChatGPT araç onayı ve sunucu tarafı izin birlikte gerekecek. Her eylemin kimliği, kapsamı, başlangıç/bitiş ve sonucu kaydedilecek; sırlar loglanmayacak.
- PC kapalıysa veya oturum kilitliyse GUI işlemine devam edilmez; bağlantı yeniden gelene kadar hata/durum döner. Otomatik yönetici yükseltmesi yapılmaz.

## 7. Uzun iş ve runner entegrasyonu

- OpenAI MCP Tunnel tek çağrının yaklaşık 120 saniyelik son teslim sınırına sahip. APK build, test ve uzun taramalar `pc_start_job` ile arka planda başlatılıp `job_id` döndürür; durum/log/artifact ayrı araçlardan izlenir.
- Mevcut `fenotip-tv` etiketli GitHub self-hosted runner, CI hattındaki görevi korur. İşler runner veya yerel build motoruna yönlendirilebilir fakat aynı emülatörün eşzamanlı iki iş tarafından kullanılmasına izin verilmez.
- Kullanıcının Fenotip öncelik sırası: 1. CI build, 2. güvenlik, 3. oynatıcı kararlılığı. Canlıya kullanıcı izni olmadan çıkılmaz; başlangıçta `android/` kapsamında yazma, webOS ve canlı web deploy salt okunur.

## 8. Aşamalar ve kabul testleri

1. **Keşif/sağlık:** PC'de kurulu Feno sürümü, tunnel-client sağlığı, connector, Windows oturumu, ADB, Git ve runner teyidi. `pc_status` normal ChatGPT sohbetinden `turn_token` olmadan çalışmalı; mevcut Codex araçları token olmadan reddedilmeye devam etmeli.
2. **Dosya ve CI:** İzinli projede okuma, küçük patch, `git diff`, geri alma ve build job akışı. Kök dışı erişim, yanlış parametre ve onaysız yazma reddi testleri.
3. **Ekran/ADB:** Gerçek Windows pencere listesi, ekran görüntüsü, kontrollü tık/tuş; Android TV emülatöründe ekran -> eylem -> yeni ekran kanıtı.
4. **Fenotip uçtan uca:** APK build, uygulama açılışı, film oynatma/menü/sarma testleri, hata kaydı, düzeltme, yeniden test. Birden fazla işlem arasında emülatör kilidi.
5. **Regresyon/geri dönüş:** `Codex Native2` normal Codex full-mode araç testi, ayrı normal ChatGPT PC testi, tunnel yeniden bağlanma, oturum kilidi, Feno güncellemesi, bağlantı kesilmesi ve acil durdurma. Başarısızlık halinde `pc_*` tek ayarla kapanmalı, eski `codex_*` davranışı sürmeli.

## 9. Uygulama öncesi karar ve sınırlar

- Kullanıcı **tam PC kontrolünü** ve **Feno Bridge'in mevcut düzeninde genişletme** yaklaşımını seçti.
- Benim tasarım kararım: PC kontrolü varsayılan kapalı, yerel süreli onaylı, proje-kapsamlı; cihazda özel sır tutulur; Codex tarafına müdahale yok.
- Henüz yerel PC'ye bağlanılmadı, kurulu sürüm veya çalışan tünel doğrulanmadı ve **hiçbir kod/kurulum/deploy değişikliği yapılmadı**.
- Bu belge onaylanınca: uygulama planı, güvenli geliştirme dalı, test öncelikleri ve aşamalı devreye alma hazırlanacak. Feno sürüm yayınlama adımları mevcut yayın sürecini kullanacak; prod/kurulu uygulama ancak açık onayla güncellenecek.
