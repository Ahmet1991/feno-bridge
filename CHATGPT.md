---
name: feno-bridge-guide
description: Use when supporting Feno Bridge/Feno Köprüsü, its updates, Codex Native2, or native Windows Computer Use in a Codex task on a machine with Feno Bridge. Check available tools before following host-specific steps.
---

# Feno Bridge: yeni konuşmalar için bilinen çözümler

Bu dosya Feno Bridge sürümüyle birlikte dağıtılır. Yalnızca ilgili sorunla ilgili bölümü kullan; kullanıcı isteği ve o makinedeki gerçek araçlar önceliklidir. Bu rehber tek başına eksik bir eklentiyi veya yetkiyi kurmaz.

## Windows masaüstünde Computer Use

Kullanıcı yerel Windows masaüstünü veya yerel bir uygulamayı görmeni ya da kontrol etmeni isterse, mevcut `computer-use` skill'ini oku. Araçlar ertelenmişse `tool_search` ile `node_repl` aracını ara. Bu ortamda yerel Windows denetimi `node_repl` içinde `@oai/sky` üzerinden sağlanabilir: `sky.list_apps()` veya `sky.list_windows()` ile gerçekten erişilebilir pencereleri doğrula, sonra dönen pencereyi hedefle.

`mcp__cua_repl__js` aracının “Native computer APIs are disabled” demesi yalnızca o aracın yerel masaüstü yolu hakkında bilgi verir; `@oai/sky` yolunun da kapalı olduğunu kanıtlamaz. Tersine, başka bir makinede `node_repl`, `@oai/sky` veya Computer Use eklentisi yoksa bunların var olduğunu varsayma. Önce araçları doğrula, yoksa hangi parça eksikse açıkça bildir. Tarayıcı görevlerinde tarayıcı aracını kullan.

## Feno güncellemeleri

Kurulu Feno, herkese açık en son GitHub Release sürümünü denetler. Sol alttaki **Güncellemeleri denetle** düğmesi yeni sürüm varsa indirip doğrulayarak kurar; yeni sürüm yoksa **Güncel** gösterir. Kaynak koda yapılan değişiklik tek başına kurulu uygulamalara geçmez. Yayın için sürüm artırılıp paketler GitHub Actions tarafından yayımlanmalıdır; bakımcı temiz repoda `YAYINLA.bat` kullanır ve `YAYIN_TAMAM` sonucunu bekler. Kullanıcı sürümünü ve yayımlanmış son sürümü karşılaştırmadan “güncellendi” deme.

Güncelleme sırasında kurulum kapanır veya yeniden açılmazsa önce kurulu sürümü, güncelleme günlüklerini ve yayın durumunu kontrol et. Ayarları, ChatGPT oturumunu veya Codex profilini silerek başlamayın. Kurulum bağlantısı: https://github.com/Ahmet1991/feno-bridge/releases/latest/download/feno-bridge-setup.exe

## `stream disconnected` ve yeniden bağlanma

Bu genel belirti tek bir sebep kanıtlamaz. ChatGPT sayfasındaki değişiklik, oturum/hesap sınırı, kapanan tarayıcı yüzeyi, Codex yönlendirmesi veya uzun süren bir araç çağrısı olabilir. Son ayrıntılı hatayı ve Feno sürümünü al; yeni bir Codex görevinde bir kez tekrar dene; Feno'da **Ayarlar → Sistem kontrolünü çalıştır** ve **Etkinlik → Güvenli günlüğü dışa aktar** adımlarını kullan. Ekran görüntüsü veya güvenli günlük paylaşılırken oturum çerezlerini, API anahtarlarını ve özel konuşma içeriğini yayımlama.

Güncel proje belgeleri: https://github.com/Ahmet1991/feno-bridge/blob/main/TROUBLESHOOTING.md ve https://github.com/Ahmet1991/feno-bridge/blob/main/docs/release-validation.md
