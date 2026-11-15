const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
const {spawnSync}=require('node:child_process');
const fs=require('node:fs');

test('PC settings renders all closed permission toggles, application catalog and high-risk warnings',()=>{
  const result=spawnSync('bun',[path.join(__dirname,'fixtures/pc-settings-render.tsx')],{encoding:'utf8',windowsHide:true});
  assert.equal(result.status,0,result.stderr);
  assert.match(result.stdout,/PC erişimi kapalı/);
  assert.match(result.stdout,/Windows hesabınızın yetkileriyle/);
  assert.match(result.stdout,/Ayrı yerel izinler/);
  assert.match(result.stdout,/varsayılan kapalı/);
  assert.match(result.stdout,/disabled/);
  for(const message of ['Tam ekran ve çoklu monitör','Çift tıklama ve sürükle-bırak','Seçilen uygulamaları başlat',
    'YÜKSEK RİSK','DEV emekliliğini geri al','DEV emekliye ayrıldı olarak işaretle']){
    assert.ok(result.stdout.includes(message),message);
  }
  assert.match(result.stdout,/Tek profil: DEV kurulu değil/);
  assert.match(result.stdout,/DEV çalışıyor/);
  assert.match(result.stdout,/Son otomatik durdurma/);
  assert.match(result.stdout,/pc-settings-checkbox/);
  assert.match(result.stdout,/Tam yetki AÇIK/);
  assert.match(result.stdout,/Tam yetkiyi kapat/);
  const css=fs.readFileSync(path.join(__dirname,'../src/styles.css'),'utf8');
  assert.match(css,/\.pc-settings-checkbox:checked/);
  assert.match(css,/\.pc-settings-checkbox:focus-visible/);
});
