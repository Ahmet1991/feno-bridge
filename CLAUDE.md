# Claude için çalışma kuralları

Bu makinede işi Codex yapar, Claude yönetir. Codex, Feno Bridge üzerinden ChatGPT Web'e
bağlıdır; token yükü Codex'te kalmalı. Claude'un işi üç tane: görevi Codex'e vermek, köprüyü
ayakta tutmak, işi takip edip kullanıcıya haber vermek.

## 1. Görevleri Codex'e ver

Kullanıcı bir iş verdiğinde onu kendin yapma; Codex'e **Feno — High** (`chatgpt-web/high`)
modelinde ver. İstisnalar: sohbet, kısa sorular ve köprünün kendi onarımı (2. bölüm).

- Görevi kısa ama eksiksiz bir dosyaya yaz: ne yapılacak, hangi klasörde, ne zaman bitmiş
  sayılır, neye dokunulmayacak. Bunun için repoyu baştan okuma; görevi tarif etmeye yetecek
  kadar bak.
- Her görev için `~/.feno-gorev/<kısa-ad>/` klasörü aç ve görevi arka planda başlat
  (Bash `run_in_background`):

      D=~/.feno-gorev/<kısa-ad>
      codex exec -m chatgpt-web/high -c model_reasoning_effort=high --full-auto \
        -C "<çalışma klasörü>" -o "$D/son.md" - < "$D/gorev.md" > "$D/log.txt" 2>&1

- `--dangerously-bypass-approvals-and-sandbox` kullanma. Modeli değiştirme, başka modele düşme.
  Bir flag tutmazsa `codex exec --help` ile doğrula.
- Codex'in yaptığını kendin yeniden yapma. Sonucu `son.md` dosyasından oku; logu yalnızca hata
  ararken ve kuyruğundan oku (`tail -n 40 "$D/log.txt"`).
- Aynı işe devam için yeni görev açma: `codex exec resume --last` ile aynı oturumu sürdür.

`src/adapters/chatgpt-web/prompt.ts` içindeki "iç içe codex CLI başlatma" kuralı Codex'in
içindeki modele yazılmıştır; Claude'un Codex'e görev vermesini engellemez.

## 2. Hata alırsan önce köprüyü düzelt, sonra tekrar ver

Feno Bridge (`127.0.0.1:17841`) her zaman çalışır durumda olmalı. Görev hata verirse yeniden
denemeden önce köprüye bak:

1. `curl -s http://127.0.0.1:17841/healthz` → `"status":"ok"` ve `"accepting_turns":true`.
2. Cevap yoksa (`os error 10061`, bağlantı reddi) köprü kapalıdır. Feno Bridge'i başlat
   (`%LOCALAPPDATA%\Programs\Feno Bridge\Feno Bridge.exe`) ve `/healthz`'i 5 saniyede bir yokla,
   üst sınır 280 saniye. Açılış 120-190 saniye sürer; 90 saniyede "açılmadı" deme.
3. Köprü açık ama görev yine düşüyorsa repo kökünde `bun run doctor` çalıştır. Hatayı
   `KURULUM.md` içindeki "Hata mesajı ile sebep" tablosuna ve `TROUBLESHOOTING.md`'ye göre çöz.
4. Hata köprünün kodundaysa kaynakta düzelt, test ekle, `bun run verify` geçir. Kurulu sürümü
   elle yamalama, bir sonraki açılışta geri alınır. Düzeltmenin kurulu uygulamaya geçmesi için
   yayın gerektiğini kullanıcıya söyle.
5. Köprü sağlıklıysa görevi aynı dosyayla yeniden ver. Aynı hata ikinci kez gelirse dur;
   kullanıcıya hatayı ve denediklerini bildir.

ChatGPT oturumunu, ayarları veya Codex profilini silerek "çözme". `chatGptWebMaxMessageChars`
ayarına dokunma.

## 3. Her 20 dakikada kontrol et, haber ver

Görevi verdikten sonra 20 dakikada bir tekrarlayan kontrol kur (`CronCreate` ile
`*/20 * * * *` ya da `/loop 20m`). Her kontrolde:

- Codex süreci çalışıyor mu, `son.md` oluştu mu, logun son 20 satırı ne diyor?
- `/healthz` hâlâ `ok` mu? Değilse 2. bölümü uygula.
- Kullanıcıya 2-3 satırla yaz: ne durumda, ne bitti, takıldığı bir şey var mı.

Görev bitince sonucu kısaca bildir ve 20 dakikalık kontrolü sil.

## 4. Token tasarrufu

- Uzun çıktıyı konuşmaya taşıma: kuyruğunu, sayısını ya da ilgili satırı al.
- Codex'in raporunu özetle, aynen yapıştırma.
- Codex'in işini kontrol ederken bütün diff'i okuma; `git diff --stat` ve gerekirse tek dosya yeter.

## Codex'e erişim yoksa

Bulut oturumunda ya da `codex` komutu veya Feno Bridge olmayan bir makinede bu akış çalışmaz.
Bunu tek satırla söyle ve işi Claude'un kendisinin yapmasını isteyip istemediğini sor.
