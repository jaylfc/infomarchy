import {expect, test} from 'bun:test';
import {existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, symlinkSync, rmSync} from 'fs';
import {join} from 'path';
import {tmpdir} from 'os';
import {qrMatrixForUrl, copyWebLink} from './web-server';

for (const scenario of ['unknown','legacy','lan','launch-failure']) test.skipIf(!existsSync('/usr/bin/quickshell'))('actual QML setup recovery: '+scenario, async () => {
  const dir=mkdtempSync(join(tmpdir(),'infomarchy-setup-'));
  mkdirSync(join(dir,'infomarchy'));
  const saved={privacyMode:false,webEnabled:true,...(scenario==='legacy'?{}:{webAccessMode:scenario==='unknown'?'typo':scenario==='lan'?'lan':'manual'})};
  writeFileSync(join(dir,'infomarchy/dashboard.json'),JSON.stringify(saved));
  let qml=readFileSync(join(import.meta.dir,'InfoSettings.qml'),'utf8');
  qml=qml.replace('  id: root','  id: root\n  property string reviewWriter: "/nonexistent/infomarchy-test-bun"');
  if(scenario==='launch-failure') qml=qml.replace('command: ["bun", Qt.resolvedUrl("dashboard-state.ts")','command: [root.reviewWriter, Qt.resolvedUrl("dashboard-state.ts")');
  writeFileSync(join(dir,'InfoSettings.qml'),qml);
  symlinkSync(join(import.meta.dir,'dashboard-state.ts'),join(dir,'dashboard-state.ts'));
  writeFileSync(join(dir,'web-server.ts'),`import {appendFileSync} from 'fs';appendFileSync(${JSON.stringify(join(dir,'calls'))},process.argv.slice(2).join(' ')+'\\n');console.log(JSON.stringify({ok:true,running:false,ready:false}));`);
  const action = scenario==='launch-failure' ? `
    if(stage===0 && s.ready) {stage=1;s.setPrivacyMode(true)}
    else if(stage===1 && !s.settingsWriting && s.settingsError && !s.privacyMode) {stage=2;s.reviewWriter="bun";s.setPrivacyMode(true)}
    else if(stage===2 && !s.settingsWriting && !s.settingsError && s.privacyMode) {console.log("RECOVERY_OK");Qt.quit()}
  ` : `
    if(stage===0 && s.ready) {
      // A removed or unknown mode loads as unset and off, and is never replaced by another mode.
      if(!s.webModeUnset || s.webEnabled || s.webAccessMode!=="") {console.log("FAILED load");Qt.quit();return}
      if(${scenario!=='unknown'} && s.webStatusText.indexOf("LAN HTTP was removed")<0) {console.log("FAILED message");Qt.quit();return}
      s.setWebEnabled(true); if(s.webEnabled) {console.log("FAILED enable");Qt.quit();return}
      s.setWebAccessMode("lan"); if(s.webAccessMode!=="") {console.log("FAILED lan");Qt.quit();return}
      stage=1
    } else if(stage>=1 && stage<30 && !s.settingsWriting) stage++
    else if(stage===30) {console.log("RECOVERY_OK");Qt.quit()}
  `;
  writeFileSync(join(dir,'shell.qml'),`import QtQuick\nimport Quickshell\nShellRoot { InfoSettings {id:s} Timer {property int stage:0;interval:50;running:true;repeat:true;onTriggered:{${action}}} }`);
  const p=Bun.spawn(['/usr/bin/quickshell','--no-color','-p',dir],{env:{...process.env,XDG_STATE_HOME:dir,QT_QPA_PLATFORM:'offscreen'},stdout:'pipe',stderr:'pipe'});
  const timer=setTimeout(()=>p.kill('SIGKILL'),7000);
  try {
    const output=(await Promise.all([new Response(p.stdout).text(),new Response(p.stderr).text()])).join('\n');
    expect(await p.exited).toBe(0);expect(output).toContain('RECOVERY_OK');
    expect(output).not.toMatch(/ReferenceError|TypeError|Cannot assign to non-existent/);
    const disk=JSON.parse(readFileSync(join(dir,'infomarchy/dashboard.json'),'utf8'));
    if(scenario==='launch-failure') expect(disk.privacyMode).toBe(true);
    else {
      // The saved mode is left as it was, WEB is saved off once, and the stale listener state is disabled.
      expect(disk.webEnabled).toBe(false);
      expect(disk.webAccessMode).toBe(saved.webAccessMode);
      expect(readFileSync(join(dir,'calls'),'utf8').split('\n')).toContain('disable');
    }
  } finally {clearTimeout(timer);p.kill('SIGKILL');await p.exited;rmSync(dir,{recursive:true,force:true});}
},10000);

test('missing QR and clipboard tools fail without exposing a viewer credential', async () => {
  const synthetic = 'https://example.invalid:8789/t/' + 'a'.repeat(48) + '/';
  expect(await qrMatrixForUrl(synthetic, '/nonexistent/qrencode')).toEqual([]);
  expect(await copyWebLink(synthetic, '/nonexistent/wl-copy')).toBe(false);
});
