# Görev 5/6 — Normal PC2 masaüstü entegrasyonu

## Kapsam ve geçiş

Görev 4'ün commit edilmemiş çekirdeği korunur. Normal MCP'ye pencere listeleme, tek pencere PNG, kontrollü girdi, uygulama açma, ayrı izinli tam ekran/monitör, emülatör ADB ve GitHub runner durum araçları eklenir. Mevcut `codex_*` ve 13 `pc_*` imzası korunur. Canlı uygulama, DEV profili, dağıtım ve kurulum değişmez.

## Güvenlik tasarımı

1. Profilden türetilmiş, launcher imzalı grant her çağrıda doğrulanır. `allowedApps` yalnız yerel katalogdan seçilen çalıştırılabilir adları içerir; başlatmada modelden çalıştırılabilir yol veya ek parametre alınmaz.
2. `screen.read`, `desktop.input`, `desktop.advanced`, `apps.launch`, `screen.full`, `adb`, `runner` ayrı ve varsayılan kapalı izinlerdir. Tam ekran, pencere iznini genişletmez.
3. Windows yardımcısı yalnız belgelenmiş Win32/GDI API kullanır. Her giriş olayı öncesi hedef HWND, PID, başlık, ön plan, odak ve etkin masaüstü yeniden kontrol edilir; odak yoksa `pc_focus_required` döner. Parola kontrolü ve yetki yükseltme pencereleri reddedilir.
4. Her giriş ve ADB işlemi, Görev 4'ün paylaşılan süreçler arası kilidi altında gerçekleşir. İptal sinyali ve grant kimliği asenkron sınırlar boyunca yeniden kontrol edilir; başarısız temizlik kilidi korur.
5. Pencere/monitör PNG bellekte üretilir, boyut ve PNG imzası kontrol edilir, yerel dosyaya yazılmaz. ADB yalnız yerel `emulator-NNNN` seri kimliğine ve bağlı emülatöre izin verir.

## Doğrulama

İzole birim testleri: yetki/parametre/uygulama listesi/profil/odak/parola/kira/iptal/ADB fiziksel cihaz reddi. Gerçek masaüstü E2E yalnız `FENO_PC_DESKTOP_E2E=1` ile kendi açılan test penceresini hedefler. Defender sayısı ve son tespit test turu öncesi/sonrası okunur; yeni tespit varsa sonraki testler çalıştırılmaz. Görev 4'ün sekiz kapısı ayrı Node süreçlerinde çalıştırılır. Son raporda kanıtlanmayan adımlar açıkça belirtilir.

## Yardımcı bütünlüğü — ek güvenlik düzeltmesi

`scripts/build-pc-windows-helper.cjs`, C# yardımcısını `.cache/pc-windows-helper.exe` içine derledikten sonra gerçek baytların SHA-256 değerini `launcher/electron/pc-windows-helper.sha256` dosyasına UTF-8 olarak yazar. Masaüstü yardımcısı her yeni `spawn` öncesinde sürümlü Bun çalışma zamanı yanındaki `pc-windows-helper.exe` dosyasının boyutunu, normal dosya oluşunu ve SHA-256 eşleşmesini senkron kontrol eder. Eksik dosya `pc_helper_missing`, değişmiş dosya veya bozuk/eksik bildirim `pc_helper_untrusted` olarak çağrıyı süreç başlatmadan keser. `pc_status.desktop` aynı kullanılamama nedenini gösterir. Bu kaynak geliştirme ağacında yardımcının `.cache` çıktısı yalnız test içindir; normal çalışma yolunda otomatik kullanılmaz.

Görev 6 paketlemede derleme sonucundaki **aynı** EXE, sürümlü/korunan Bun çalışma zamanının yanına konulmalı; bildirim, uygulamanın salt okunur kaynaklarına dahil edilerek `import.meta.dir` üzerinden okunabilir olmalıdır. Paketleme sonrası gerçek dizin ve ACL doğrulaması, eşleşen dosya/bildirim kontrolü ve `pc_status` smoke testi yapılmalıdır. Kullanıcı tarafından yazılabilen veri klasörüne geri dönüş yolu eklenmez. Windows üzerinde harici eşzamanlı dosya değiştirme kaynaklı dar doğrulama/başlatma yarışı için klasör ACL koruması zorunludur. Eski PowerShell yardımcısı ve test penceresi betiği kullanım dışı kalıp kaldırılmıştır.

## Yayın sınırı

Bu görev kaynak ve test düzeyindedir. Görev 6 paketleme ve canlı kabul testlerine geçilmez. Tek profil kurulumunda bütün 40 kabul testi geçmeden DEV kaldırılmaz.
