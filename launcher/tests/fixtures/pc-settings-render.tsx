import {renderToStaticMarkup} from 'react-dom/server';
import {PcSettings} from '../../src/PcSettings';
process.stdout.write(renderToStaticMarkup(<PcSettings api={undefined} platform="win32"/>));
const {PC_PERMISSION_DETAILS,PC_ALLOWED_APPLICATIONS}=require('../../electron/pc-profile-policy.cjs');
const base={enabled:false,available:true,profileId:'pc2-normal' as const,roots:[],permissions:[],allowedApps:[],
  permissionDetails:PC_PERMISSION_DETAILS,applicationCatalog:PC_ALLOWED_APPLICATIONS};
for(const mode of ['not-installed','retired','running','unverified'] as const){
  process.stdout.write('\n'+renderToStaticMarkup(<PcSettings api={undefined} platform="win32"
    initialStatus={{...base,devMode:mode,devRetired:mode==='retired'}}/>));
}
process.stdout.write('\n'+renderToStaticMarkup(<PcSettings api={undefined} platform="win32"
  initialStatus={{...base,lastAutoStop:{at:Date.UTC(2026,10,16),reason:'channel_unavailable',code:'ETIMEDOUT'}}}/>));
