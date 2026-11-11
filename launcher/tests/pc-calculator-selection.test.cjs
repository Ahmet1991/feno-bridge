const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname,'../src/App.tsx'),'utf8');

function selectedApps(advanced,broad) {
  const expression=source.match(/allowedApps:\s*(\["Code\.exe"[\s\S]*?\]),\s*\n\s*\}\)\)/)?.[1];
  assert.ok(expression,'Locate the real approval payload, rather than a duplicate test policy');
  return Array.from(vm.runInNewContext(expression,{pcAdvancedTerminal:advanced,pcBroadDesktop:broad}));
}

test('each approval preset permits the dedicated Calculator process without granting generic UWP hosts',()=>{
  for(const advanced of [false,true]) for(const broad of [false,true]) {
    const apps=selectedApps(advanced,broad);
    assert.equal(apps.filter(name=>name==='CalculatorApp.exe').length,1);
    assert.equal(apps.includes('ApplicationFrameHost.exe'),false);
    assert.equal(apps.includes('WindowsTerminal.exe'),advanced);
    assert.equal(apps.includes('chrome.exe'),broad);
  }
});

test('an existing approval missing Calculator can be updated without toggling or dropping existing capabilities',()=>{
  const start=source.indexOf('{pcControl.enabled && (');
  const end=source.indexOf(') ? (',start);
  assert.ok(start>=0&&end>start);
  const condition=source.slice(start+1,end+1);
  const scope={pcRoot:'D:\\GitHub',pcAdvancedTerminal:true,pcBroadDesktop:true,pcPersistent:true,
    pcControl:{enabled:true,roots:['D:\\GitHub'],permissions:['terminal.exec'],expiresAt:null,
      allowedApps:selectedApps(true,true).filter(name=>name!=='CalculatorApp.exe')}};
  assert.equal(vm.runInNewContext(condition,scope),true);
  scope.pcControl.allowedApps=selectedApps(true,true);
  assert.equal(vm.runInNewContext(condition,scope),false);
});
