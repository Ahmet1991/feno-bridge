# Akentek PC Bridge: Gelişmiş terminal izni tasarımı

## Neden

Akentek projelerinde yeni geliştirme, hata ayıklama ve CLI araçları için sürekli yeni sabit görev tanımlamak yerine kullanıcı tarafından **bir kez ayrıca açılabilen**, genel terminal komutlarını yürütebilen DEV modu.

## Seçim ve sınırlar

- Sabit görev kataloğu çok dar; kalıcı sınırsız komut ise Windows hesabındaki tüm dosyalara erişebilir. Kullanıcının tam kontrol talebini karşılamak üzere **ayrı bir açık riskli `terminal.exec` yetkisi** seçildi.
- Normal Feno, Codex ve mevcut `jobs` izni aynen kalır. `terminal.exec` olmadan **hiçbir** terminal çalıştırılamaz; uzak API kendine yetki veremez.
- `terminal.exec` yerel Windows DEV uygulamasındaki kapsamı ve riskleri açıkça gösteren ikinci onayla verilir. Mevcut süresiz yerel izin özelliği korunur; kullanıcı tek tek komut onaylamak zorunda değildir.
- Komutlar Windows kullanıcısı haklarıyla ve onaylanan proje klasörü çalışma dizininden çalışır, **OS sandbox'ı değildir**. Dizin kapsamı çalışma dizinini bağlar, alt süreçlerin kişisel klasörleri veya ağı okumasını teknik olarak engellemez. Kullanıcının güvenlik için ayrı bir Windows hesabı/VM istemesi durumunda bu mod o hesapta çalıştırılmalıdır.
- Kullanıcıya yerel **Acil durdur / İzni sil** her zaman kalır. Uzaktan UAC yükseltme, kilit açma veya güvenlik kapatma uygulanmaz.

## Teknik sözleşme

- `pc_start_terminal({ projectRoot, command, purpose })` yeni MCP aracı. `purpose` görünür niyet özeti, `command` PowerShell komut metnidir (uzunluk sınırlı, NUL içermez).
- Hem `jobs` hem `terminal.exec` yerel izinleri zorunlu. İş `pc_job_status`, `pc_job_logs`, `pc_cancel_job` ile izlenir.
- `powershell.exe` sabit Windows sistem yolundan `-NoLogo -NoProfile -NonInteractive -Command` ile, `shell:false`, stdin kapalı çalışır. Bir adet eşzamanlı gelişmiş terminal; azami 10 dakika; döngüde 5 saniyelik uygulama kontrolü; genel PC işleri için mevcut toplam dört iş sınırı.
- İş kaydı yerel logda zaman, redakte edilmiş amaç, çalışma klasörü ve komut SHA256 içerir. Komut metni ya da örneği asla açık olarak loglanmaz.
- Kullanıcı acil durdur yaptığında çalışan çocuk süreç ağacı sonlandırılır. Yetki kapanınca status/log da reddedilir.
- Önceden verilmiş `jobs` yetkisinin otomatik `terminal.exec`'e yükseltilmesi **yasak**. Varsayılan uygulama ekranında yeni izin kapalıdır.

## Dağıtım engeli

Windows'ta canlı olan Feno Bridge DEV'in kalıcı izin yerel değişiklikleri GitHub PR #94'e henüz taşınmamış olabilir. Bunlar birleştirilip Windows üzerinde ayrı DEV kurulumu sınanmadan ne normal Feno'ya ne kullanıcının bilgisayarına güncelleme dağıtılır.
