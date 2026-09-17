---
name: feno-bridge-guide
description: Use when supporting Feno Bridge/Feno Köprüsü, its updates, Codex Native2, or native Windows Computer Use in a Codex task on a machine with Feno Bridge. Check available tools before following host-specific steps.
---

# Feno Bridge: yeni konuşmalar için bilinen çözümler

Bu dosya Feno Bridge sürümüyle birlikte dağıtılır. Yalnızca ilgili sorunla ilgili bölümü kullan; kullanıcı isteği ve o makinedeki gerçek araçlar önceliklidir. Bu rehber tek başına eksik bir eklentiyi veya yetkiyi kurmaz.

## Windows masaüstünde Computer Use

Kullanıcı yerel Windows masaüstünü, Dosya Gezgini'ni veya başka bir yerel uygulamayı görmeni ya da kontrol etmeni isterse önce o oturumda sunulan `computer-use:computer-use` skill'ini oku. Skill'in ilgili işlem için istediği guidance, API ve confirmation belgelerini de işlemden önce oku. Eklenti sürümü ve kurulum yolu makineler arasında değişebileceği için kullanıcıya özel mutlak bir eklenti yolunu varsayma.

`node_repl` ertelenmiş araçsa mevcut araç keşif mekanizmasıyla bul. `tool_search` sunuluyorsa `node_repl` ara; aracın gerçek adı ve kullanılabilirliğini dönen araç listesinden doğrula. Var olmayan araç çağrıları uydurma.

Taze bir `node_repl` JavaScript oturumunda native Windows yolunu şöyle başlat:

```js
if (!globalThis.sky) {
  const { sky } = await import("@oai/sky");
  globalThis.sky = sky;
}
```

Ardından erişimi gerçekten sınamak için aynı oturumda mevcut pencereleri veya uygulamaları listele:

```js
globalThis.windows = await sky.list_windows();
nodeRepl.write(JSON.stringify(globalThis.windows, null, 2));
```

Gerektiğinde `sky.list_apps()` da kullanılabilir. Hedef pencereyi yalnızca güncel `list_windows()` / `list_apps()` sonucunda gerçekten dönen nesneler arasından seç. Birden fazla aday varsa mevcut başlık ve uygulama bilgisiyle tek hedef belirle. Önceki oturumdan pencere kimliği, sabit liste sırası veya erişilebilirlik indeksi kopyalama.

İşlem döngüsü gözlem → işlem → doğrulama şeklinde ilerlemeli: hedef pencerenin güncel durumunu oku, görüntü veya erişilebilirlik ağacını incele, güncel gözleme göre işlem yap, sonra durumu yeniden okuyup sonucu doğrula. Pencere kapanmışsa gerektiğinde pencere listesini yenileyerek kapanmayı doğrula.

`mcp__cua_repl` tarafındaki boş `apps: []` sonucu veya `Native computer APIs are disabled` mesajı, `node_repl` + `@oai/sky` yolunun da kapalı olduğunu kanıtlamaz. Yerel Windows için bu native rota sınanmadan kullanıcıya masaüstüne erişilemediğini söyleme.

`node_repl` bulunamıyorsa, `@oai/sky` yüklenemiyorsa veya native çağrı hata veriyorsa hangi bileşenin eksik ya da başarısız olduğunu açıkça raporla. Başka makinelerde aynı kurulumun bulunduğunu varsayma. Gerçek izin reddi, kilitli masaüstü, kullanıcı tarafından durdurma veya geçerli confirmation gereksinimine uy; bu engelleri başka araçla aşmaya çalışma.

Tarayıcı görevlerinde uygun tarayıcı araçlarını kullan; yerel Windows uygulamalarında native yolu kullan. Kullanıcı aynı konuşmada işlemi zaten istemişse, yalnızca yöntemi hatırlattığı veya yeni mesaj gönderdiği için mevcut yetkilendirmeyi yok sayma. Yeni risk, kapsam değişikliği veya geçerli bir confirmation zorunluluğu varsa ona göre davran; kaydedilmemiş veriyi atma gibi ayrı bir sonucu basit pencere kapatma isteğinden otomatik çıkarma.

Raporlamayı gerçek araç çıktısına dayandır. Gerçek bir ret/hata olmadan “güvenlik filtresi engelledi” deme ve yalnızca denenmiş bir işlemi tamamlanmış gibi anlatma.

## Feno güncellemeleri

Kurulu Feno, herkese açık en son GitHub Release sürümünü denetler. Sol alttaki **Güncellemeleri denetle** düğmesi yeni sürüm varsa indirip doğrulayarak kurar; yeni sürüm yoksa **Güncel** gösterir. Kaynak koda yapılan değişiklik tek başına kurulu uygulamalara geçmez. Yayın için sürüm artırılıp paketler GitHub Actions tarafından yayımlanmalıdır; bakımcı temiz repoda `YAYINLA.bat` kullanır ve `YAYIN_TAMAM` sonucunu bekler. Kullanıcı sürümünü ve yayımlanmış son sürümü karşılaştırmadan “güncellendi” deme.

Güncelleme sırasında kurulum kapanır veya yeniden açılmazsa önce kurulu sürümü, güncelleme günlüklerini ve yayın durumunu kontrol et. Ayarları, ChatGPT oturumunu veya Codex profilini silerek başlamayın. Kurulum bağlantısı: https://github.com/Ahmet1991/feno-bridge/releases/latest/download/feno-bridge-setup.exe

## `stream disconnected` ve yeniden bağlanma

Bu genel belirti tek bir sebep kanıtlamaz. ChatGPT sayfasındaki değişiklik, oturum/hesap sınırı, kapanan tarayıcı yüzeyi, Codex yönlendirmesi veya uzun süren bir araç çağrısı olabilir. Son ayrıntılı hatayı ve Feno sürümünü al; yeni bir Codex görevinde bir kez tekrar dene; Feno'da **Ayarlar → Sistem kontrolünü çalıştır** ve **Etkinlik → Güvenli günlüğü dışa aktar** adımlarını kullan. Ekran görüntüsü veya güvenli günlük paylaşılırken oturum çerezlerini, API anahtarlarını ve özel konuşma içeriğini yayımlama.

Güncel proje belgeleri: https://github.com/Ahmet1991/feno-bridge/blob/main/TROUBLESHOOTING.md ve https://github.com/Ahmet1991/feno-bridge/blob/main/docs/release-validation.md
