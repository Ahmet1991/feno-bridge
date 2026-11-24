# Sohbetten Codex görevi — tasarım (taslak, 24.11.2026)

## Amaç

Kullanıcı normal Chrome'daki ChatGPT sohbetinden, Native2 bağlantısıyla "şu işi yap, 3 alt ajan
kullan" diyebilsin. Feno bilgisayarda bir Codex görevi açar, görev alt ajanlarını kendi
sekmelerinde çalıştırır, sonuç aynı sohbete döner.

Üç şart:

1. Codex/OpenAI kotası harcanmaz. Görev ve bütün alt ajanları yalnız `chatgpt-web/*` modelleriyle
   çalışır; düşünen taraf ChatGPT web aboneliğidir, Codex yalnız yerel "eller"dir.
2. Kullanıcı açmadıkça kapalıdır; açıkken ne çalıştığı launcher'da görünür ve tek tıkla durur.
3. Feno güncellemesi ya da yeniden başlatma çalışan görevi sessizce öldürmez.

## Bugünkü durum (kodda ve canlıda ölçüldü)

- `codex_*` araçları her çağrıda Feno'nun verdiği görev biletini ister (`mcp-server.ts`
  `claimTurn`). Bilet yalnız Codex'in Feno'ya gönderdiği bir görevde, Feno'nun açtığı sekmede
  vardır. Kullanıcının kendi açtığı sohbette yoktur; bu yol normal sohbete kapalıdır.
- `pc_*` araçları bilet istemez; yerel izinlerle (`PC_PERMISSIONS`, tam yetki) normal sohbetten
  çalışır. Kullanıcının bilgisayarında tam yetki açıktır.
- `pc_start_terminal` bugün `codex exec` çalıştırabilir, ama işe yaramaz düzeyde sınırlıdır:
  - süre en çok 10 dakika (`jobs.ts` `MAX_TIMEOUT`),
  - aynı anda en çok 2 terminal (tam yetkide; seçmeli modda 1),
  - komut en çok 2048 karakter, görev metni ayrıca dosyaya yazılmalı,
  - model sabitlenmez; alt ajan gerçek Codex modeline düşerse kota harcar,
  - Feno'nun güncelleme denetimi (`main.cjs` etkinlik sayımı) yalnız etkin HTTP/tarayıcı
    turlarını sayar. İki model çağrısı arasında görev "boşta" görünür ve güncelleme görevi keser.
- Alt ajan yolu çalışıyor: 24.11 denemesinde `codex exec -m chatgpt-web/high` iki alt ajan açtı
  (`spawn_agent` + `wait_agent`), 150 saniyede iki doğru cevap döndü. Model trafiğinin hepsi
  `127.0.0.1:17841`'e gitti.
- Feno aynı anda en çok 5 ChatGPT sekmesi açar (`browser-host.cjs` `MAX_BROWSER_TABS`).

## Önerilen araçlar (Native2, `pc_` ailesi)

| Araç | Girdi | Çıktı |
| --- | --- | --- |
| `pc_codex_task_start` | `projectRoot` (izinli kök), `title` (≤80), `prompt` (≤64 KiB), `effort` (`high`/`medium`/`light`, varsayılan `high`), `maxSubagents` (0–4, varsayılan 3), `timeoutMinutes` (1–240, varsayılan 60) | `taskId`, `state` |
| `pc_codex_task_wait` | `taskId`, `waitSeconds` (1–50, varsayılan 45) | `state`, `elapsedSeconds`, `subagentsStarted`, `activeTabs`; bitince `finalMessage` (≤32 KiB) ya da `error` |
| `pc_codex_task_list` | — | son 20 görev: kimlik, başlık, durum, zamanlar (görev metni yok) |
| `pc_codex_task_cancel` | `taskId` | `state: cancelled` |
| `pc_codex_task_logs` | `taskId`, `cursor` | mevcut iş günlüğü sayfalaması ve gizli anahtar maskesi |

`state`: `queued`, `running`, `completed`, `failed`, `cancelled`, `timed_out`, `interrupted`.

`pc_codex_task_wait` ChatGPT'nin araç zaman aşımına (~90 sn) takılmamak için en çok 50 saniye
bekler; bitmediyse durumu döndürür ve sohbet tekrar çağırır. Feno `wait_agent` için de benzer
bir kısa yoklama sözleşmesi kullanıyor (10 saniye). Araç açıklaması "bitmedi demek başarısız
demek değil" diye yazar.

## Çalışma şekli

1. **İzin.** Yeni izin `codex.tasks`, yanında `jobs`. Varsayılan kapalı (bkz. Açık kararlar 2).
2. **Ön denetim.** Feno `/healthz` `accepting_turns:true` değilse `pc_codex_route_unavailable`.
   Codex CLI bulunamazsa `pc_codex_not_installed`. Bu sürümde aynı anda tek sohbet görevi
   (`pc_codex_busy`).
3. **Sekme bütçesi.** Boş sekme = 5 − açık sekmeler. Kök görev 1 sekme ister; `maxSubagents`
   boş sekme − 1'e indirilir. Hiç yer yoksa `pc_codex_tabs_full`. İndirilen değer yanıtta döner.
4. **Görev klasörü.** Feno'nun korumalı profil dizini altında `codex-tasks/<taskId>/`
   (`gorev.md`, `son.md`, `log.txt`). Temp kullanılmaz. 7 gün sonra silinir.
5. **Komut.** Feno kendisi kurar; sohbet komut satırına dokunamaz:

       codex exec -m chatgpt-web/<effort> -c model_reasoning_effort=<effort>
         -c openai_base_url="http://127.0.0.1:<feno-port>/v1"
         -c model_catalog_json="<görev klasörü>/models.json"
         -c agents.max_threads=<maxSubagents>   # anlamı uygulamada doğrulanacak
         -c agents.max_depth=1
         [--skip-git-repo-check]                # projectRoot git deposu değilse
         -C <projectRoot> -o <görev klasörü>/son.md -   < gorev.md

   Sandbox ya da onay bayrağı verilmez; kullanıcının `~/.codex/config.toml` ayarı geçerlidir.
   `maxSubagents=0` ise `features.multi_agent=false` verilir.
6. **Model kilidi.** `models.json`, Feno'nun yönlendirdiği satırlardan yalnız `chatgpt-web/*`
   olanlarla üretilir. Gerçek Codex modelleri listede olmadığı için bir alt ajan onları isterse
   hata alır, kota harcanmaz. Testte kanıtlanacak (bkz. Testler).
7. **Süreç sınırı.** Görev mevcut iş altyapısıyla (Windows iş nesnesi) başlatılır. İptal ya da
   süre aşımı `codex.exe` ve onu başlatan `node` sürecini birlikte kapatır. 05.11'deki "durdurulan
   görev arkada yazmaya devam etti" sorunu bu yolla oluşmaz.
8. **Güncelleme ve yeniden başlatma.** Çalışan sohbet görevleri launcher'ın etkinlik sayımına
   eklenir; Feno'nun kendi güncellemesi görev bitene kadar bekler. Zorla kapanışta görev
   `interrupted` olur ve sohbet bunu `pc_codex_task_wait` ile öğrenir.
9. **Sohbet silme.** Görevin ve alt ajanlarının sekmeleri Feno'nundur; sekme kapanınca bugünkü
   otomatik silme onları da siler. Kullanıcının kendi sohbetine dokunulmaz.
10. **Sonuç.** `finalMessage` = `son.md` (en çok 32 KiB, fazlası kesilir ve bu belirtilir).
    `subagentsStarted`, görev günlüğündeki alt ajan başlatma kayıtlarından sayılır.
11. **Kayıt.** `pc-tool-audit.jsonl` bugünkü gibi yalnız araç adı, zaman, sonuç ve hata kodu
    tutar. Görev metni yalnız görev klasöründe kalır.

## Launcher

- Ayarlar → PC: **"Sohbetten Codex görevi"** anahtarı, altında **"Her görevde sor"** anahtarı.
- Etkinlik: çalışan sohbet görevleri (başlık, süre, açık sekme, alt ajan sayısı, **Durdur**).
- "Her görevde sor" açıksa yerel pencere: başlık, klasör, alt ajan sınırı, süre sınırı ve
  görev metninin ilk 600 karakteri. **Başlat / Reddet**; 2 dakika cevap gelmezse reddedilir
  (`pc_codex_task_denied`).

## Güvenlik

- Görev, Windows hesabının ve Codex tam yetkisinin gücüyle çalışır. Bu, bugün tam yetkide zaten
  açık olan `pc_start_terminal` ile aynı güçtür; yeni bir güç sınıfı açmaz. Yine de ChatGPT
  kotasını ve 5 sekmeyi tükettiği için ayrı izindir.
- Asıl risk: sohbet kötü niyetli bir web sayfası okuduktan sonra bir görev başlatabilir.
  Önlemler: varsayılan kapalı izin, isteğe bağlı görev başı onay, launcher'da görünür liste ve
  Durdur, `projectRoot` yalnız izinli köklerden, tek görev sınırı, kayıt.
- Model kilidi (madde 6) kota harcamasını önler. Bilet ya da oturum bilgisi sohbete dönmez.
- Yalnız PC2 normal profili; DEV profilinde araçlar kayıtlı olmaz.

## Testler

Birim:
- giriş sınırları, izin denetimi (`codex.tasks` + `jobs`), DEV profilinde araç yokluğu;
- kurulan komut satırı birebir (sandbox bayrağı yok, katalog yolu, `max_threads`, git dışı
  klasörde `--skip-git-repo-check`);
- katalog süzgeci yalnız `chatgpt-web/*` satırlarını bırakır;
- sekme bütçesi ve `maxSubagents` indirimi; tek görev sınırı;
- iptal ve süre aşımı süreç ağacını kapatır;
- etkinlik sayımı çalışan görevi sayar; zorla kapanışta `interrupted`.

Canlı (yayın öncesi):
1. Normal sohbetten 3 alt ajanlı görev: 4 sekme açılır, sonuç sohbete döner.
2. Alt ajandan gerçek Codex modeli istenir: hata döner, kota kullanılmaz.
3. Görev ortasında Durdur: `codex.exe` kalmaz.
4. Görev çalışırken Feno güncellemesi: güncelleme görev bitene kadar bekler.
5. 5 sekme doluyken başlatma: `pc_codex_tabs_full`.

## Platform

İlk sürüm yalnız Windows'ta (iş nesnesi ve PC2 normal profili orada). macOS/Linux'ta araçlar
kayıtlı olmaz ve `pc_status` bunu söyler.

## Uygulama parçaları (Codex'e verilecek)

1. Çekirdek görev yöneticisi, katalog süzgeci, komut kurucu ve birim testleri (`src/pc-control/`).
2. MCP araçları, `codex.tasks` izni, hata kodları ve testleri.
3. Launcher: ayar anahtarları, etkinlik listesi, onay penceresi, güncelleme beklemesi.
4. Sürüm yükseltme, `bun run verify`, yayın ve canlı test listesi.

## Açık kararlar

1. **Her görevde sor** varsayılanı. Öneri: kapalı. Tam yetki açıkken sohbet bugün de aynı gücü
   terminal yoluyla kullanabiliyor; görev başı onay güvenliği az artırır, her işte tıklama ister.
2. **Tam yetki `codex.tasks`'ı da kapsasın mı?** Öneri: hayır, ayrı anahtar. Kota ve sekme
   tükettiği için kullanıcı bilerek açsın.
3. **Sınırlar.** Öneri: varsayılan 3 alt ajan (en çok 4), 60 dakika (en çok 240), aynı anda tek
   sohbet görevi.
