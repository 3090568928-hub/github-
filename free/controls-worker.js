'use strict';
chrome.runtime.onMessage.addListener((msg,sender,reply)=>{
  if(sender.id!==chrome.runtime.id || msg?.type!=='input-key-binding') return;
  chrome.commands.getAll().then(commands=>reply(commands.find(c=>c.name==='translate-input')?.shortcut || ''),()=>reply(''));
  return true;
});
chrome.runtime.onInstalled.addListener(()=> {
  chrome.contextMenus.removeAll().then(()=>{
    chrome.contextMenus.create({id:'geb-selection',title:'翻译选中文字',contexts:['selection'],documentUrlPatterns:['http://*/*','https://*/*','file:///*']});
    chrome.contextMenus.create({id:'geb-page',title:'翻译网页 / 显示原文',contexts:['page'],documentUrlPatterns:['http://*/*','https://*/*','file:///*']});
  });
});
chrome.contextMenus.onClicked.addListener((info,tab)=>{
  if(tab?.id==null) return;
  if(info.menuItemId==='geb-page') chrome.tabs.sendMessage(tab.id,{type:'toggle-page'},{frameId:0}).catch(()=>{});
  if(info.menuItemId==='geb-selection') chrome.tabs.sendMessage(tab.id,{type:'translate-selection',text:info.selectionText},{frameId:info.frameId??0}).catch(()=>{});
});
chrome.commands.onCommand.addListener((command,tab)=>{
  if (tab?.id==null) return;
  if(command==='open-side-panel') { chrome.sidePanel.open({windowId:tab.windowId}).catch(()=>{}); return; }
  if(command==='translate-input') chrome.tabs.sendMessage(tab.id,{type:'translate-input'}).catch(()=>{});
  if(command==='toggle-page') chrome.tabs.sendMessage(tab.id,{type:'toggle-page'},{frameId:0}).catch(()=>{});
});
