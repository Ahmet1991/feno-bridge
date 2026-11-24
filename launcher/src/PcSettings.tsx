import {useEffect,useState} from 'react';
import type {LauncherApi,PcControlStatus,PcCorePermission} from './types';

const permissions:PcCorePermission[]=['files.read','files.write','jobs','terminal.exec','screen.read','desktop.input','desktop.advanced','apps.launch','screen.full','adb','runner','browser'];
const labels:Record<PcCorePermission,string>={
  'files.read':'Dosyaları oku','files.write':'Dosyaları düzenle',jobs:'Proje işleri',
  'terminal.exec':'Terminal','screen.read':'İzinli pencereyi gör','desktop.input':'Pencereye tıklama ve yazma',
  'desktop.advanced':'Çift tık ve sürükle-bırak','apps.launch':'İzinli uygulamayı aç',
  'screen.full':'Tüm ekranı veya monitörü gör',adb:'Android emülatörü',runner:'GitHub runner durumu',browser:'Arka planda web tarayıcısı',
  'chrome.user':'Kendi Chrome sekmeleriniz',
  'codex.tasks':'Sohbetten Codex görevi',
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
  const taskEnabled=status?.profileId==='pc2-normal'&&status.pcCodexTasks===true;
  const visiblePermissions:PcCorePermission[]=taskEnabled?[...permissions,'codex.tasks']:permissions;
  const effectiveSelected=selected.filter(p=>p!=='codex.tasks'||taskEnabled);
  const invalid=((effectiveSelected.includes('terminal.exec')||effectiveSelected.includes('codex.tasks'))&&!effectiveSelected.includes('jobs'))
    ||(selected.includes('desktop.advanced')&&!selected.includes('desktop.input'))
    ||(needsApps&&!selectedApps.length)
    ||(selected.includes('apps.launch')&&!selectedApps.some(app=>status?.applicationCatalog?.some(item=>item.id===app&&item.launchable)));
  return <section className="settings-list" aria-label="Yerel PC erişimi">
    <h3>Yerel PC araçları</h3>
    <p role="status">{status?.enabled?'PC erişimi açık':'PC erişimi kapalı'}{status?.profileId?` · ${status.profileId}`:''}</p>
    <p>Terminal ve proje betikleri Windows hesabınızın yetkileriyle çalışır. Yerel izinler birbirinden bağımsızdır ve başlangıçta kapalıdır.</p>
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
    {platform==='win32'&&status?.profileId==='pc2-normal'?<div aria-label="Chrome uzantısı">
      <h3>Chrome uzantısı</h3>
      <p role="status">{status.chrome?.connected?'Bağlı':'Bağlı değil'} · Sürüm: {status.chrome?.version||'—'}</p>
      <p>Kendi Chrome profilinizde çalışır. Sayfada PC2 imlecini görürsünüz; pencere kendiliğinden öne gelmez. Tam yetki ve bu anahtarın açık olması gerekir.</p>
      <label className="pc-settings-option"><input className="pc-settings-checkbox" type="checkbox" role="switch" checked={status.chrome?.enabled===true} disabled={busy||!status.chromeAvailable}
        onChange={event=>{const enabled=event.target.checked;void action(async()=>{await api!.pcChromeToggle(enabled);});}}/> Chrome erişimini aç / kapat</label>
      <button type="button" disabled={busy} onClick={()=>void action(async()=>{await api!.pcChromeFolder();})}>Uzantı klasörünü aç</button>
      <button type="button" disabled={busy} onClick={()=>void action(async()=>{await api!.pcChromeExtensions();})}>Chrome uzantılar sayfasını aç</button>
      <ol><li>Chrome uzantılar sayfasını açın ve Geliştirici modu'nu etkinleştirin.</li><li>Paketlenmemiş öğe yükle düğmesine basıp Feno Bridge uzantı klasörünü seçin.</li><li>Bağlantıyı kontrol edin. Tam yetkide ilk bağlantıda erişim açılır; daha önce kapattıysanız bu ayar korunur.</li></ol>
    </div>:null}
    {platform!=='win32'||!status?.available?<p>PC güvenlik altyapısı hazır değil. Erişim kapalı tutuluyor.</p>:null}
    {status?.persistentRevocationPending?<p role="alert">Kalıcı iptal diske yazılamadı. Erişim kapalı. Depolama erişimini onarın.</p>:null}
    {status?.lastAutoStop?<p role="alert">Son otomatik durdurma: {new Date(status.lastAutoStop.at).toLocaleString('tr-TR')} · {status.lastAutoStop.reason} ({status.lastAutoStop.code})</p>:null}
    {platform==='win32'&&status?.profileId==='pc2-normal'?<div aria-label="Sohbetten Codex görevi ayarları">
      <label className="pc-settings-option"><input className="pc-settings-checkbox" type="checkbox" role="switch" checked={taskEnabled} disabled={busy||!status.available}
        onChange={event=>{const enabled=event.target.checked;void action(async()=>{setStatus(await api!.pcCodexTaskFlag('pcCodexTasks',enabled));if(!enabled)setSelected(previous=>previous.filter(p=>p!=='codex.tasks'));});}}/> Sohbetten Codex görevi</label>
      <p>ChatGPT sohbeti bilgisayarda Codex görevi başlatabilir; ChatGPT kotanızı ve en çok 5 Feno sekmesini kullanır.</p>
      <label className="pc-settings-option"><input className="pc-settings-checkbox" type="checkbox" role="switch" checked={status.pcCodexTasksConfirm===true} disabled={busy||!status.available||!taskEnabled}
        onChange={event=>{const enabled=event.target.checked;void action(async()=>{setStatus(await api!.pcCodexTaskFlag('pcCodexTasksConfirm',enabled));});}}/> Her görevde sor</label>
    </div>:null}
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
      {visiblePermissions.map(permission=><label className="pc-settings-option" key={permission}>
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
    <button type="button" disabled={busy||!status?.available||!root||!effectiveSelected.length||invalid||status?.persistentRevocationPending}
      onClick={()=>void action(async()=>{setStatus(await api!.pcApprove({durationMs:perpetual?null:3600000,roots:[root],permissions:effectiveSelected,allowedApps:selectedApps}));})}>Seçili izinleri yerel olarak onayla</button>
    <button type="button" disabled={busy||!status?.available} onClick={()=>void action(async()=>{setStatus(await api!.pcRevoke());})}>İzni iptal et ve unut</button>
    </>:null}
    {error?<p role="alert">{error}</p>:null}
  </section>;
}
