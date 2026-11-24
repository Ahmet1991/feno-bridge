"use strict";
const path=require('node:path');
const deny=()=>new Error('pc_access_denied');
function assertPcProfileId(profileId) {
  if(profileId !== 'pc2-normal' && profileId !== 'pc2-dev') throw deny();
  return profileId;
}
const PC_PERMISSION_DETAILS=Object.freeze(Object.fromEntries(Object.entries({
  'files.read':{title:'Proje dosyalarını oku',risk:'medium',description:'Seçtiğiniz projelerdeki dosyaların içeriği okunabilir; proje içindeki kişisel bilgiler de görülebilir.'},
  'files.write':{title:'Proje dosyalarını değiştir',risk:'high',description:'Seçtiğiniz projelerde dosya oluşturulabilir ve içerikleri değiştirilebilir; projenin davranışı etkilenebilir.'},
  jobs:{title:'Proje görevlerini çalıştır',risk:'high',description:'Proje betikleri Windows hesabınızın yetkileriyle çalışır; seçili klasörün dışındaki dosyalara ve ağa erişebilir.'},
  'terminal.exec':{title:'Windows komutlarını çalıştır',risk:'high',description:'Komutlar Windows hesabınızın yetkileriyle çalışır; kişisel dosyalarınıza, kimlik bilgilerinize ve ağa erişebilir.'},
  'screen.read':{title:'Uygulama ekranlarını gör',risk:'medium',description:'İzin verdiğiniz uygulamaların ekran içeriği görülebilir; ekranda açık özel bilgiler de paylaşılabilir.'},
  'desktop.input':{title:'Uygulamalarda işlem yap',risk:'high',description:'İzinli pencerelerde tıklama ve yazma yapılabilir; açık hesaplarınızda ve proje dışı dosyalarda işlem gerçekleşebilir.'},
  adb:{title:'Android cihazını kontrol et',risk:'high',description:'Bağlı Android cihazlarının ekranı görülebilir ve giriş gönderilebilir; fiziksel cihazlar da kapsamda olabilir.'},
  runner:{title:'GitHub runner durumunu oku',risk:'medium',description:'Yerel GitHub oturumuyla yapılandırılmış runner durumu sorgulanabilir; görev başlatma yetkisi vermez.'},
  'desktop.advanced':{title:'Çift tıklama ve sürükle-bırak',risk:'high',description:'İzin verilen uygulama penceresinde çift tıklama ve sürükleme yapılabilir. Ayrıca masaüstü girişi izni gerektirir.'},
  'apps.launch':{title:'Seçilen uygulamaları başlat',risk:'high',description:'Yalnızca seçilen ve sistemde güvenilir konuma kurulu uygulamalar açılabilir. Tarayıcıya bir web adresi gönderilebilir.'},
  'screen.full':{title:'Tam ekran ve çoklu monitör görüntüsü',risk:'high',description:'YÜKSEK RİSK: Tüm ekran veya bir monitördeki diğer uygulamalar, bildirimler ve özel içerikler görünür. Pencere okuma izninden bağımsızdır.'},
  browser:{title:'Arka planda web tarayıcısı',risk:'high',description:'Ayrı kalıcı tarayıcı profilinde sayfalar okunabilir, tıklama ve yazma yapılabilir. Açık hesaplarda işlem yapılabilir.'},
  'chrome.user':{title:'Kendi Chrome sekmeleriniz',risk:'high',description:'Tam yetkide, uzantı açıkken mevcut Chrome profilindeki web sayfalarında işlem yapılabilir.'},
}).map(([key,value])=>[key,Object.freeze(value)])));
const PC_ALLOWED_APPLICATIONS=Object.freeze([
  {id:'notepad.exe',title:'Not Defteri',launchable:true},
  {id:'chrome.exe',title:'Google Chrome',launchable:true},
  {id:'msedge.exe',title:'Microsoft Edge',launchable:true},
  {id:'explorer.exe',title:'Dosya Gezgini',launchable:false},
  {id:'Code.exe',title:'Visual Studio Code',launchable:false},
  {id:'CalculatorApp.exe',title:'Hesap Makinesi',launchable:false},
]);
const PC_PERMISSIONS=Object.freeze(['status',...Object.keys(PC_PERMISSION_DETAILS),'codex.tasks']);
const PC_FULL_PERMISSIONS=Object.freeze(PC_PERMISSIONS.filter(permission=>permission!=='status'&&permission!=='codex.tasks'));
function validatePcSelection(s) {
  const full=s?.fullAccess===true;
  if(!full&&Array.isArray(s?.permissions)&&s.permissions.includes('chrome.user'))throw deny();
  const validRoot=r=>typeof r==='string'&&r.length>1&&r.length<=1024&&!r.includes('\0')&&!r.startsWith('\\\\')
    &&(/^[a-z]:[\\/]/i.test(r)?!r.slice(2).includes(':')&&(full||path.win32.normalize(r).toLowerCase()!==path.win32.parse(r).root.toLowerCase()):process.platform!=='win32'&&path.posix.isAbsolute(r)&&path.posix.normalize(r)!=='/');
  if(!s||typeof s!=='object'||(s.durationMs!==null&&(!Number.isSafeInteger(s.durationMs)||s.durationMs<=0||s.durationMs>7200000))
    ||!Array.isArray(s.roots)||s.roots.length>(full?26:16)||!s.roots.every(validRoot)
    ||!Array.isArray(s.permissions)||s.permissions.length<1||s.permissions.length>PC_PERMISSIONS.length
    ||new Set(s.permissions).size!==s.permissions.length||!s.permissions.every(p=>PC_PERMISSIONS.includes(p))
    ||!Array.isArray(s.allowedApps)||s.allowedApps.length>32||!s.allowedApps.every(p=>typeof p==='string'&&/^[a-zA-Z0-9_. -]{1,100}$/.test(p))
    ||(s.fullAccess!==undefined&&typeof s.fullAccess!=='boolean')
    ||(full&&(s.durationMs!==null||s.roots.length<1||!s.roots.every(r=>/^[a-z]:\\$/i.test(r))
      ||s.allowedApps.length!==0||s.permissions.length!==PC_FULL_PERMISSIONS.length+Number(s.permissions.includes('codex.tasks'))
      ||!PC_FULL_PERMISSIONS.every(permission=>s.permissions.includes(permission)))))throw deny();
}
const copyPcSelection=s=>({durationMs:s.durationMs,...(s.fullAccess===true?{fullAccess:true}:{}),roots:[...s.roots],permissions:[...s.permissions],allowedApps:[...s.allowedApps]});
function pcPolicyForProfile(profile) {
  if(!profile || !['production','development'].includes(profile.kind)
    || !path.isAbsolute(profile.coreHome || '') || !path.isAbsolute(profile.userData || '')) throw deny();
  const profileId=profile.kind==='production'?'pc2-normal':'pc2-dev';
  return Object.freeze({profileId,defaultEnabled:false,
    defaultDurationMs:3600000,maxDurationMs:7200000,
    persistentStorePath:path.join(profile.userData,'pc-control',profileId,'pc-permanent-consent.enc'),
    legacyPersistentStorePath:profileId==='pc2-dev'?path.join(profile.userData,'pc-permanent-consent.enc'):undefined,
    runtimeDirectory:path.join(profile.coreHome,'runtime',profileId),permissionDetails:PC_PERMISSION_DETAILS});
}
module.exports={assertPcProfileId,pcPolicyForProfile,PC_PERMISSION_DETAILS,PC_PERMISSIONS,PC_FULL_PERMISSIONS,PC_ALLOWED_APPLICATIONS,validatePcSelection,copyPcSelection};
