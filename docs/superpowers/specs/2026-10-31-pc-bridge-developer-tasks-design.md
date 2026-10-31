# Akentek PC Bridge: Kalıcı geliştirici görevleri tasarımı

## Amaç

ChatGPT'nin mevcut, kullanıcı tarafından yerelde onaylanmış Feno Bridge DEV tünelinden Windows üzerindeki birden fazla Akentek projesini incelemesi, kod değişikliklerini test etmesi ve Android TV emülatörünü kontrol etmesi; her görev için tekrar izin istememesi.

## Mevcut durum

- Canlı DEV sürümünde süresiz yerel izin ve acil durdur var. Bu çalışma o yerel değişiklikleri **yeniden yazmayacak**, mevcut `jobs` iznini kullanacak.
- GitHub PR #94'teki kaynak 60 dakikalık izinle sınırlı; canlı Windows DEV sürümündeki kalıcılık güncellemeleri henüz bu dalda görünmüyor. Canlı sürüme dağıtımdan önce kod farkları birleştirilmeli.
- `pc_start_job` dört sabit görev sunuyor ve yalnız tek onaylı proje köküne bağlanıyor. Android projesinde Gradle wrapper bulunmayınca `android-build` reddediliyor.

## Yaklaşım seçenekleri

1. **Her görev için yeni sabit `pc_*` aracı:** Dar yetkili fakat her yeni proje için tekrar kod değişikliği gerektirir.
2. **Onaylı proje görev kataloğu (seçilen):** Yerel dosyalardan doğrulanan test/build/lint, sabit Gradle ve salt-okunur Git görevlerini listeler; kullanıcı bir kez `D:\\GitHub` gibi bir proje üst klasörünü onaylar. Görevler izinli kök içinde çalışan kullanıcının yetkisiyle yürütülür.
3. **Süresiz serbest terminal:** Çok esnek; fakat Node/npm, PowerShell, Git yapılandırması ve alt süreçler proje klasörü dışına da çıkabilir. Kalıcı tünelde işletim sistemi sandbox'ı olmadan güvenli kabul edilmiyor.

## İlk kapsam

- `pc_list_project_tasks(projectRoot)`: Onaylı bir klasördeki desteklenen, güvenli adlandırılmış proje görevlerini listeler.
- `pc_start_project_task(projectRoot, taskId)`: Katalogdan tek görev başlatır; var olan `pc_job_status`, `pc_job_logs`, `pc_cancel_job` akışını kullanır.
- `package.json` içinde `test`, `lint`, `check`, `typecheck`, `build`, `verify` ve bunların güvenli `:<varyant>` uzantılarını destekler. Adında `deploy`, `release`, `publish`, `prod`, `wipe`, `clean` bulunanları dışlar.
- Projede gerçek `android/gradlew.bat` mevcutsa sabit `assembleDebug`, `testDebugUnitTest`, `lintDebug` görevlerini destekler. Git read-only `status`, `diff --stat`, `log -5` görevleri sunar.
- Katalog, onaylanan kökün altındaki birden fazla proje için çalışır; symlink ve kök dışına kaçışlar yerel gerçek yol denetiminden geçer.
- İşler en fazla dört paralel çalışır; günlük satırı sınırı, gizli veri maskeleme ve acil durdur davranışı korunur.

## Sınırlar ve açık işler

- Bu **tam sistem yöneticisi** veya **herhangi bir komutu çalıştıran shell** değildir. Windows UAC, kilit ekranı, banka/şifre dosyaları veya canlı dağıtım iznini genişletmez.
- Proje içinden çalıştırılan bir build script'i Windows kullanıcısı yetkisiyle çalışır; işletim sistemi seviyesinde gerçek proje izolasyonu sağlamaz. Bu yüzden yalnız güvenilen depolar için yerel onay verilmeli.
- Yerel DEV uygulamasını güncellemek ve mevcut onaylı kökü `D:\\GitHub` seviyesine genişletmek yalnız kullanıcının Windows ekranında gerçekleşebilir. MCP üzerinden yetki değiştirilemez.
- PR #94'teki eski süreli izin kodu ile Windows'ta kullanılan kalıcı izin kodunun farkı birleştirilmeden hiçbir kurulum paketi yayınlanamaz.
- Daha sonra gerekli olursa kontrollü proje dosyası oluşturma, Git commit ve izole terminal işlemleri ayrı incelemeyle eklenebilir.
