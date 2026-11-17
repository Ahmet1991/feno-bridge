import {useEffect,useState} from 'react';
import type {LauncherApi,PcControlStatus,PcCorePermission} from './types';

const permissions:PcCorePermission[]=['files.read','files.write','jobs','terminal.exec','screen.read','desktop.input','desktop.advanced','apps.launch','screen.full','adb','runner'];
const labels:Record<PcCorePermission,string>={
  'files.read':'Dosyaları oku','files.write':'Dosyaları düzenle',jobs:'Proje işleri',
  'terminal.exec':'Terminal','screen.read':'İzinli pencereyi gör','desktop.input':'Pencereye tıklama ve yazma',
  'desktop.advanced':'Çift tık ve sürükle-bırak','apps.launch':'İzinli uygulamayı aç',
  'screen.full':'Tüm ekranı veya monitörü gör',adb:'Android emülatörü',runner:'GitHub runner durumu',
};

export function PcSettings({api,platform,initialStatus=null}:{api:LauncherApi|undefined;platform:string;initialStatus?:PcControlStatus|null}){
  const [status,setStatus]=useState<PcControlStatus|null>(initialStatus),[root,setRoot]=useState('');
  const [selected,setSelected]=useState<PcCorePermission[]>([]),[selectedApps,setSelectedApps]=useState<string[]>([]);
  const [perpetual,setPerpetual]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState<string|null>(null);
  useEffect(()=>{
    if(!api)return;let alive=true;
    const refresh=()=>{void api.pcStatus().then(value=>{if(alive)setStatus(value);}).catch(()=>{if(alive)setStatus(null);});};
    refresh();const timer=setInterval(refresh,2000);return()=>{alive=false;clearInterval(timer);};
  },[api]);
  async function action(run:()=>Promise<void>){
    setBusy(true);setError(null);
    try{await run();}catch{setError('Yerel onay tamamlanamadı. İzinleri ve güvenlik durumunu kontrol edin.');}
    finally{setBusy(false);if(api)void api.pcStatus().then(setStatus).catch(()=>{});}
  }
  const needsApps=selected.some(permission=>['screen.read','desktop.input','apps.launch'].includes(permission));
  const invalid=(selected.includes('terminal.exec')&&!selected.includes('jobs'))
    ||(selected.includes('desktop.advanced')&&!selected.includes('desktop.input'))
    ||(needsApps&&!selectedApps.length)
    ||(selected.includes('apps.launch')&&!selectedApps.some(app=>status?.applicationCatalog?.some(item=>item.id===app&&item.launchable)));
  return <section className="settings-list" aria-label="Yerel PC erişimi">
    <h3>Yerel PC araçları</h3>
    <p role="status">{status?.enabled?'PC erişimi açık':'PC erişimi kapalı'}{status?.profileId?` · ${status.profileId}`:''}</p>
    <p>Terminal ve proje betikleri Windows hesabınızın yetkileriyle çalışır. Yerel izinler birbirinden bağımsızdır ve başlangıçta kapalıdır.</p>
    {status?.profileId==='pc2-normal'?<div aria-label="Ekran görüntüsü yedeği">
      <h4>Telefon için ekran görüntüsü yedeği</h4>
      <p>{status.pcScreenshotMirrorDir||'Kapalı — görüntüler klasöre kaydedilmiyor.'}</p>
      <p>İzinli bir klasör seçin (ör. Drive içindeki PC2-Ekran). Son 50 PC2 görüntüsü saklanır.</p>
      <button type="button" disabled={busy||!status.available||!status.permissions.includes('files.write')}
        onClick={()=>void action(async()=>{setStatus(await api!.pcScreenshotMirror(true));})}>Yedek klasörü seç</button>
      <button type="button" disabled={busy||!status.available||!status.pcScreenshotMirrorDir}
        onClick={()=>void action(async()=>{setStatus(await api!.pcScreenshotMirror(false));})}>Yedeklemeyi kapat</button>
    </div>:null}
    {status?.profileId==='pc2-normal'?<div aria-label="DEV koordinasyon durumu">
      <p role="status">{status.devMode==='not-installed'?'Tek profil: DEV kurulu değil':
        status.devMode==='retired'?'DEV emekliye ayrıldı':
        status.devMode==='running'?'DEV çalışıyor: ortak kaynak koordinasyonu devrede':
        status.devMode==='compatible'?'DEV ile uyumlu kaynak koordinasyonu':
        'DEV durumu doğrulanamadı: ortak kaynak işlemleri korunuyor'}</p>
      <button type="button" disabled={busy||!status.available||status.devMode==='running'||status.devMode==='compatible'}
        onClick={()=>void action(async()=>{setStatus(await api!.pcRetireDev(!status.devRetired));})}>
        {status.devRetired?'DEV emekliliğini geri al':'DEV emekliye ayrıldı olarak işaretle'}
      </button>
    </div>:null}
    {platform!=='win32'||!status?.available?<p>PC güvenlik altyapısı hazır değil. Erişim kapalı tutuluyor.</p>:null}
    {status?.persistentRevocationPending?<p role="alert">Kalıcı iptal diske yazılamadı. Erişim kapalı. Depolama erişimini onarın.</p>:null}
    {status?.lastAutoStop?<p role="alert">Son otomatik durdurma: {new Date(status.lastAutoStop.at).toLocaleString('tr-TR')} · {status.lastAutoStop.reason} ({status.lastAutoStop.code})</p>:null}
    {status?.fullAccess?<div aria-label="Tam yetki modu">
      <p role="status"><strong>Tam yetki AÇIK</strong> · tüm yerel sabit sürücüler ve uygulamalar · süresiz</p>
      <button type="button" disabled={busy||!status.available}
        onClick={()=>void action(async()=>{setStatus(await api!.pcDisableFullAccess());})}>Tam yetkiyi kapat</button>
    </div>:null}
    {status?.enabled?<p>İzinli proje: {status.roots.join(', ')} · {status.expiresAt===null?'Açıkça iptal edilene kadar':status.expiresAt?new Date(status.expiresAt).toLocaleString():''}</p>:null}
    {!status?.fullAccess?<>
    <button type="button" disabled={busy||!status?.available} onClick={()=>void action(async()=>{const picked=await api!.pcPickRoot();if(picked)setRoot(picked);})}>Proje seç</button>
    <p>{root||'Henüz proje seçilmedi'}</p>
    <fieldset disabled={busy||!status?.available}>
      <legend>Ayrı yerel izinler (varsayılan kapalı)</legend>
      {permissions.map(permission=><label className="pc-settings-option" key={permission}>
        <input className="pc-settings-checkbox" type="checkbox" checked={selected.includes(permission)} onChange={event=>setSelected(previous=>event.target.checked?[...previous,permission]:previous.filter(p=>p!==permission))}/>
        <span><strong>{status?.permissionDetails?.[permission]?.title||labels[permission]}</strong>
          <small>{status?.permissionDetails?.[permission]?.description||'Bu yetkinin kapsamını yerel onay ekranında inceleyin.'}</small>
          {status?.permissionDetails?.[permission]?.risk==='high'?<small role="note">⚠ Yüksek riskli izin</small>:null}</span>
      </label>)}
    </fieldset>
    <fieldset disabled={busy||!status?.available}>
      <legend>İzin verilen uygulama pencereleri</legend>
      <p>Yalnızca seçilen uygulamaların pencereleri okunabilir ve kontrol edilebilir. Uygulama başlatma ayrı izne tabidir.</p>
      {(status?.applicationCatalog||[]).map(app=><label className="pc-settings-option" key={app.id}>
        <input className="pc-settings-checkbox" type="checkbox" checked={selectedApps.includes(app.id)} onChange={event=>setSelectedApps(previous=>event.target.checked?[...previous,app.id]:previous.filter(id=>id!==app.id))}/>
        <span>{app.title} <small>{app.launchable?'Açılabilir ve kontrol edilebilir':'Yalnızca mevcut penceresi kullanılabilir'}</small></span>
      </label>)}
    </fieldset>
    <label className="pc-settings-option"><input className="pc-settings-checkbox" type="checkbox" checked={perpetual} onChange={event=>setPerpetual(event.target.checked)}/> Açıkça iptal edene kadar sakla (DPAPI ve ayrı yerel onay gerekir)</label>
    {invalid?<p role="alert">Terminal için işler iznini, gelişmiş giriş için masaüstü girişini, pencere izinleri için en az bir uygulamayı ve uygulama açmak için açılabilir uygulamayı seçin.</p>:null}
    <button type="button" disabled={busy||!status?.available||!root||!selected.length||invalid||status?.persistentRevocationPending}
      onClick={()=>void action(async()=>{setStatus(await api!.pcApprove({durationMs:perpetual?null:3600000,roots:[root],permissions:selected,allowedApps:selectedApps}));})}>Seçili izinleri yerel olarak onayla</button>
    <button type="button" disabled={busy||!status?.available} onClick={()=>void action(async()=>{setStatus(await api!.pcRevoke());})}>İzni iptal et ve unut</button>
    </>:null}
    {error?<p role="alert">{error}</p>:null}
  </section>;
}
