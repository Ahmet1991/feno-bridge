# Feno Köprüsü — İkinci Makineye Kurulum

Bu belge, bu depoyu **yeni bir Windows makinesine** sıfırdan kurmak içindir. Adımları
sırayla uygula, her adımın sonundaki **Doğrulama** satırını gör, ancak ondan sonra bir
sonrakine geç. Bir doğrulama tutmuyorsa devam etme; aşağıdaki tuzaklara bak.

Bu depo `miuuyy/codex-chatgpt-web` projesinin özel bir fork'udur. Yaptığı iş: Codex'i
OpenAI API'si yerine **senin ChatGPT hesabının web arayüzüne** bağlamak. Codex istekleri
`127.0.0.1:17841` adresine gider, köprü onları gömülü bir tarayıcıdaki ChatGPT sekmesine
yazar, cevabı geri döndürür.

---

## 0. Ön koşullar

| Gereksinim | Değer | Kontrol |
|---|---|---|
| İşletim sistemi | Windows 10/11 | — |
| Bun | **1.4.0** (kesin) | `bun --version` |
| Node.js | 20+ | `node --version` |
| Git | herhangi | `git --version` |
| GitHub erişimi | Ahmet1991 hesabı, depo **private** | `gh auth status` |
| ChatGPT hesabı | **ücretli**, bu makineye özel | — |

Bun sürümü `package.json` içinde sabitli. Farklı sürüm kullanma.

Bu makine ayrı bir ChatGPT hesabı kullanabilir; kullanması tercih edilir. Her makine
kendi tünelini ve kendi connector'ını kurar, birbirlerine karışmazlar.

---

## 1. Depoyu klonla

    git clone https://github.com/Ahmet1991/feno-bridge.git D:\GitHub\feno-bridge
    cd D:\GitHub\feno-bridge

**Doğrulama:** `git log --oneline -1` bir commit göstermeli, `git status` temiz olmalı.

---

## 2. Bağımlılıklar

    bun install --frozen-lockfile

**Doğrulama:** Çıktının sonunda "packages installed" yazmalı, hata olmamalı.

---

## 3. Testleri koştur (kurulumdan ÖNCE)

Bu adım isteğe bağlı değil. Zincirin sağlam olduğunu kurulumdan önce bilmek gerekir.

    bun run typecheck
    bun run test
    node --test launcher/tests/*.test.cjs

**Doğrulama:** typecheck sessiz kalmalı (çıktı yok = başarılı). `bun run test` **0 fail**.
Launcher testleri **0 fail** (2 skip normaldir, Linux'a özel testler).

**Tuzak:** `tests/retained-compaction.test.ts` dosyasını `-t` ile tek başına seçersen
Windows'ta asılı kalır. Önceden var olan bir durum, hata değil. Doğrulamayı her zaman tam
paketle yap, tek test filtreleme.

---

## 4. Paketi üret

    bun run build
    bun run app:package

`build` adımı `dist/runtime` üretir. `app:package` electron-builder ile NSIS kurulumunu
üretir; birkaç dakika sürer, ilk seferde Electron indirir.

**Doğrulama:** `launcher/artifacts/feno-bridge-5.0.5-win-x64.exe` oluşmalı, ~150 MB.

---

## 5. Kur

    .\launcher\artifacts\feno-bridge-5.0.5-win-x64.exe /S

`/S` sessiz kurulum. `perMachine: false` olduğu için **yönetici yetkisi istemez**. Referans
makinede ~42 saniye sürdü.

**Doğrulama:** Şu dosya oluşmalı:
`C:\Users\<kullanıcı>\AppData\Local\Programs\Feno Bridge\Feno Bridge.exe`

### Özel depodan güncelleme

Feno Bridge, açılışta `Ahmet1991/feno-bridge` deposunun en son **Releases** sürümünü
denetler. Yeni sürüm varsa sol altta **Güncelle v…** görünür. Düğme sürümü indirir,
`checksums.txt` ile SHA-256 doğrular, uygulamayı kapatıp kurar ve yeniden açar.
Etkin Codex görevi bu sırada kesilebilir; güncellemeyi boşta yapın.

Depo özel kaldığı için her bilgisayarda depoya erişimi olan GitHub hesabıyla bir kez
GitHub CLI kurulup `gh auth login` yapılmalıdır. Tarayıcıdaki GitHub girişi tek başına
CLI'ya yetki vermez. Uygulama erişim anahtarını paketlemez veya kaydetmez; GitHub CLI'nın
yerel oturumunu kullanır. Sol alttaki **Güncellemeleri denetle** düğmesi girişten sonra
yeniden denemek içindir.

Yalnızca kodu GitHub'a göndermek sürüm yayınlamaz. `package.json` ve
`launcher/package.json` sürümleri eşit biçimde artırılıp `vX.Y.Z` etiketi gönderildiğinde
release iş akışı paketleri ve sağlamalarını aynı özel depoda yayımlar.
Eski 5.0.3/5.0.4 kurulumlarında bu denetim kapalıdır; 5.0.5 setup'ı bir kez elle kurun.

---

## 6. Köprüyü kur

    bun run setup

Bu adım makineye özel her şeyi kurar: `~/.codex-chatgpt-web/` altında config, secrets ve
tünel anahtarı; gömülü tarayıcıda ChatGPT girişi; `~/.codex/config.toml` içine Codex
yönlendirmesi. Hesabın neler yapabildiğini de yoklayıp config'e yazar.

**Doğrulama:** `~/.codex-chatgpt-web/config.json` oluşmalı ve içinde `"solAvailable": true`
bulunmalı.

`solAvailable` **false** ise **DUR ve bildir**. O hesapta `chatgpt-web/high` çalışmaz;
`~/.codex/config.toml` içindeki `model` satırının o hesabın sunduğu efora göre
değiştirilmesi gerekir. Kendi kafana göre bir model seçme.

---

## 7. Launcher'ı başlat

    & "$env:LOCALAPPDATA\Programs\Feno Bridge\Feno Bridge.exe"

**Sabırlı ol.** Launcher önce tarayıcı oturumunu tazeliyor, sonra daemon'u kaldırıyor.
Referans makinede ölçülen süre **120-190 saniye**. 90 saniyede "açılmadı" hükmü verme.

**Doğrulama:** PowerShell'de şu komut bir satır dönene kadar 5'er saniye bekle, 280 saniye
üst sınır:

    Get-NetTCPConnection -LocalPort 17841 -State Listen

---

## 8. Sağlık kontrolü

    bun run doctor

**Doğrulama:** Full harness'ta son satır şu olmalı:

    Doctor result: ready for local checks; unproven from this machine: connector

Bu **beklenen** çıktıdır, hata değil. `ready for local checks` = yerel kontrollerin hepsi
geçti; `unproven from this machine` ise doctor'un ispatlayamadığı kontrolleri sayar. Sadece
browser-only kurulumda son satır düz `Doctor result: ready` olur.

Tek bir `!` uyarısı **normaldir**: connector'ın bu tünele bağlı olduğu yerelden
ispatlanamaz. `https://chatgpt.com/#settings/Plugins` adresinden bir kez kontrol et. Bu
makine ayrı bir ChatGPT hesabı kullanıyorsa **kendi connector'ını** kurman gerekir; başka
makinenin connector'ı buraya yaramaz.

---

## 9. Codex yönlendirmesini doğrula

`~/.codex/config.toml` içinde şunlar olmalı:

    model = "chatgpt-web/high"
    model_reasoning_effort = "high"
    openai_base_url = "http://127.0.0.1:17841/v1"

`chatgpt-web/high` arayüzdeki **"Feno — High"** demektir. Başka model seçme.

---

## 10. AGENTS.md kuralını ekle

Bu dosya depoda değil, makineye özeldir ve elle oluşturulur:
`C:\Users\<kullanıcı>\.codex\AGENTS.md`

En azından şu bölüm konmalı; olmadan Codex bağlamı gereksiz şişirir. Ölçüldü: 859 satırlık
tek bir dosya listesi 48.000 token yedi ve yine de kırpıldı.

    ## Keep tool output small

    Every tool result stays in the conversation and is resent on every later turn, so a
    large listing is paid for again on each turn that follows it.

    - Keep max_output_tokens at or below 5000 unless a specific result genuinely needs
      more, and say why when you raise it.
    - Filter at the source instead of reading past the noise: narrow the pattern, add
      Select-Object -First 40, or return a count rather than a full listing.
    - When the question is whether something exists or how many there are, answer with
      the count and a few examples, not the whole set.
    - If a large result is unavoidable, take what the task needs from it in the same turn
      and do not carry the raw dump forward.

---

## Bilinen tuzaklar

Hepsi bu projede yaşandı ve pahalıya mal oldu.

### chatGptWebMaxMessageChars ayarlama

`~/.codex-chatgpt-web/config.json` içindeki bu anahtarı **ayarlama**, varsayılanda bırak
(80.000). Ölçülen gerçek:

| Değer | Sonuç |
|---|---|
| ~83.859 | çalışıyor |
| **100.000** | **ChatGPT reddediyor:** "Gönderdiğiniz mesaj çok uzun" |
| 188.673 | ChatGPT sayfasını donduruyor |

Yükseltmeye gerek de yok: taşıma 12 parçaya kadar bölüyor ve gerekirse tek bir kaydın
içini de bölüyor. Düşük sınır duvar değil, sadece daha çok parça demek.

### Kurulu sürümü elle yamalamak imkânsız

`versions/<sürüm>-win32-x64/` klasörü her launcher açılışında bir manifest'e karşı
doğrulanıyor. Elle değiştirdiğin tek karakter bir sonraki açılışta geri alınır. Tek yol
kaynakta değiştirip yeniden paketlemek.

### Kurulum runtime bundle'ı yenilemez

`app:package` + kurulum yalnızca `launcher/` tarafını (app.asar) günceller. `src/`
altındaki değişiklikler (köprü daemon'u, prompt, browser-worker) **gelmez**, çünkü aynı
sürüm numarasında kendi içinde tutarlı bir bundle zaten varsa geçerli sayılır.

`src/` değişikliğini devreye almak için kurulumdan sonra bundle'ı kenara al:

    Move-Item "$HOME\.codex-chatgpt-web\versions\5.0.5-win32-x64" "$HOME\.codex-chatgpt-web\versions\5.0.5-win32-x64.eski"

sonra launcher'ı yeniden başlat. Açılışta paketten temiz bundle'ı kendisi kurar.

Bu tuzağa bir gecede üç kez düşüldü. Atlama.

### Satır sonları

Depodaki kaynak dosyalar CRLF. Dosyaları düzenleyen betikler CRLF üretmeli, yoksa git tüm
dosyayı değişmiş gösterir.

---

## Hata mesajı ile sebep

| Mesaj | Sebep |
|---|---|
| `os error 10061` / `Reconnecting... waiting for network` | Köprü kapalı. İnternet sorunu **değil**. Önce 17841 portuna bak. |
| `HTTP 502` + `requires the incoming Bearer authorization` (curl ile) | Yanlış alarm. Codex kendi isteğinde token gönderiyor, normal. |
| `Gönderdiğiniz mesaj çok uzun` (ChatGPT arayüzünde) | `chatGptWebMaxMessageChars` çok yüksek. Varsayılana döndür. |
| `requires N characters in one message, above the configured page limit` | Bağlam tek mesaja sığmıyor. Taşıma otomatik bölmeli; hâlâ alıyorsan mesaj kaç parça gerektiğini söyler. |
| `Codex rollout path escapes the sessions directory` | Düzeltildi. Alıyorsan sürüm eski demektir, `git pull` yap. |
| `missing cwd in trusted Codex environment context` | Düzeltildi. Alıyorsan sürüm eski demektir. |
| `Even multipart browser transport up to 12 parts cannot...` | Bağlam gerçekten çok büyük. Mesaj kaç parça gerektiğini söyler; Codex bağlamını küçült. |
| ChatGPT ekranda Türkçe bir uyarı gösteriyor ama köprü bulanık bir hatayla ölüyor | Köprü o uyarıyı **metninden** tanıyor ve elindeki karşılıklar İngilizce/Çince/Japonca. Aşağıdaki bölüme bak. |

---

## ChatGPT'nin Türkçe uyarı metnini yakalamak

Köprü, ChatGPT'nin bazı uyarılarını **ekrandaki metinden** tanıyor: oturum süresi dolduğunda,
istek sınırına takıldığında, geçici sohbet karşılama kutusu çıktığında. Elindeki karşılıklar
İngilizce, kısmen Çince ve Japonca — **Türkçe yok**.

Sonucu şu: oturumun gerçekten sona erdiğinde ChatGPT sana Türkçe uyarıyı gösterir, köprü onu
göremez, ve sana `The ChatGPT session has expired. Sign in again` gibi net bir mesaj yerine
bulanık bir tur hatası döner.

Düzeltmek için **birebir metin** gerekiyor. Tahminle yazılan bir karşılık, bugünkü durumla
aynı şekilde sessizce tutmaz — o yüzden metni görmeden eklemiyoruz.

**Yakalama:** tanı ekran görüntülerini aç, hatayı bir kez tekrarlat.

    setx CODEX_CHATGPT_WEB_BROWSER_DIAGNOSTICS 1

Launcher'ı kapat-aç (yeni değişken ancak yeni süreçte görünür), hatayı bir kez üret. Görüntüler
şuraya düşer:

    %USERPROFILE%\.codex-chatgpt-web\diagnostics\browser-turns\

En yeni klasördeki `.png` dosyalarında uyarı kutusu görünür. **Sadece uyarının metnini** paylaş;
görüntülerde sohbet içeriği de olabilir, klasörün tamamını gönderme.

İşi bitince geri kapat:

    setx CODEX_CHATGPT_WEB_BROWSER_DIAGNOSTICS ""

**Şu an Türkçesi eksik olanlar** (İngilizcesiyle birlikte):

| İngilizce | Nerede çıkar |
|---|---|
| `Your session has expired` | Oturum sona erdiğinde — en önemlisi |
| `Too many requests` / `making requests too quickly` | İstek sınırı uyarısı |
| `Got it` | O uyarıyı kapatan buton |
| `Personalized` / `Unpersonalized` | Geçici sohbette kişiselleştirme düğmeleri |
| `Not in history` / `No model training` / `Memory off` + `Continue` | Geçici sohbet karşılama kutusu |
| `Failed to load subscription` | Abonelik yüklenemedi uyarısı |
| `Think` / `Deny` | Kompozer ve izin diyaloğu butonları |

---

## Güncelleme

    git pull
    bun install --frozen-lockfile
    bun run typecheck
    bun run test
    bun run build
    bun run app:package
    .\launcher\artifacts\feno-bridge-5.0.5-win-x64.exe /S

Sonra **runtime bundle'ı kenara al** (yukarıdaki tuzak) ve launcher'ı yeniden başlat. En
son `bun run doctor` çalıştır ve 8. adımdaki son satırı gör.

---

## Yapılmayacaklar

- `~/.codex-chatgpt-web/browser/storage-state.json` dosyasını başka makineden kopyalama.
  Bu senin ChatGPT oturumun; her makine kendi girişini yapmalı.
- `versions/` altındaki dosyaları elle düzenleme.
- `chatGptWebMaxMessageChars` değerini 83.859 üzerine çıkarma.
- Daemon çalışırken `versions/` klasörünü silme; önce launcher'ı kapat.
- `solAvailable: false` çıktığında kendi kafana göre model seçme; dur ve bildir.
