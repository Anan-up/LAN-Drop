[English](README.md) | [简体中文](README_Simplified_Chinese.md) | [繁體中文](README_Classical_Chinese.md)

# 區域網點對點傳檔

純白至簡之網頁傳檔之具也。文檔往來於瀏覽器之間，賴 WebRTC 點對點直連，未嘗經由伺服器中轉——伺服者惟託管頁面、撮合連接而已（WebSocket 信令）。宜於同域網之內，自一機徑傳於他機，不假第三方之伺服。

## 特性

- **真點對點**：文檔之數據行於 WebRTC DataChannel，伺服者惟轉其建連所需之握手（SDP / ICE），未嘗觸一文檔之字節。
- **純白至簡之界面**：無贅飾，尚單色，移動端自適。
- **多檔／雙向互傳**：可拖拽、可多選，發收二端可並作。
- **傳之可靠**：六十四 KB 分片加以背壓之控（bufferedAmount），依序重組，有即時之進度。
- **協商乃穩**：採 WebRTC「完美協商」之法，polite 之職由伺服者分之，杜雙方僵死之患。
- **自動重連**：WebSocket 斷而復連，用指數退避之法，歸於故室；對方既去，可待其復來，亦可隨時自去。
- **流式落盤**：若瀏覽器支持 File System Access API（HTTPS / localhost），收受之分片直寫於盤，不蓄全檔於內存，雖 GB 之巨亦不溢；其不支持者，自退為 Blob 以下載。
- **斷點續傳**：傳中斷而復連，收受者自既寫之字節續之，無俟從頭（限於同頁之會話）。
- **二維碼配對**：一按而生室之碼（兼可分享之入室之鏈），對方掃之，自填室碼而入，無煩手書。
- **收受者可拒／發者可再試**：收受者見檔可按「拒」，（發者立知，不復空待五刻）；發者一敗（對方拒收／未備／連斷），則現「再試」之鈕，一按重發，免復拖檔。
- **其安愈固**：伺服者下發 CSP 之頭（惟同源，WebSocket 既同源，connect-src 'self' 已括之），且限室碼之長、WebSocket 報文之巨（maxPayload）、及每連之消息頻率，以禦域網中之惡意妄發。
- **部署無需設**：一 Express + ws 之程足矣，HTTP / HTTPS 自適。

## 其理

```
┌──────────────┐                 WebSocket 信令（惟握手）              ┌──────────────┐
│  瀏覽器甲     │  ───────────────────────────────────────────────▶  │  信令伺服      │
│  （發者）     │  ◀───────────────────────────────────────────────  │  （本程）      │
└──────┬───────┘                                                     └──────┬───────┘
       │                                                                    │
       │            WebRTC DataChannel（文檔字節，直連）                      │
       └────────────────────────────────────────────────────────────────────┘
                                                                            │
┌──────────────┐                                                            ▼
│  瀏覽器乙     │  ◀──────── WebRTC DataChannel（文檔字節，直連） ────────────┘
│  （收者）     │
└──────────────┘
```

一、二瀏覽器皆開伺服之址，輸同室之碼，同入一室。

二、伺服者告二方可以協商（peer-ready，且分一正一反之 polite 職）。

三、二端假 WebSocket 互易 SDP / ICE 之候選，以立 P2P 之連。

四、連既立，文檔經 DataChannel 直傳於二端，伺服者自此不與。

> 域網之中，優先取本地候選之址以直連，其遲最小，不費公網之帶寬。已備公用 STUN，惟用於候選之發現，不中轉文檔之數據。

## 速用

### 一、安裝依賴

```bash
npm install
```

### 二、啟伺服

```bash
npm start
```

默聽三千之埠。可以環境變更之：

```bash
PORT=8080 npm start
```

### 三、開於瀏覽器

- 本機：`http://localhost:3000`
- 域網他器：以伺服之內網 IP 易 localhost，如 `http://192.168.1.50:3000`

### 四、始傳

一、二端皆開上之域網之址。

二、一端按「隨機」以生室碼（或手書之），按「入」；他端可輸同室之碼以入，或按「生二維碼以邀」，俾對方掃而入。

三、狀態點轉綠、「已連·可傳檔」既現，曳檔入框（可多選、可雙向）。

四、**收受者**：若瀏覽器支持 File System Access（HTTPS / localhost），先現「存為…」之鈕，一按擇所存之地，即受而流式落盤；其不然者直受之，畢按「下載」存於本機。

五、**斷點續傳**：傳中若連斷，復而二者自續於斷點，進度條繼進，無俟重傳。

## 部署

- **防堵**：務令伺服之埠（默三千）於域網可達。

- **HTTPS**：以 HTTPS 部之，WebSocket 自升為 wss://，無改其碼。生產之境，宜假反向代理（Nginx 之屬）啟 HTTPS。

- **跨網段／公網（TURN）**：今為純域網直連而設。若跨網段或跨公網，須 TURN 中繼（經於中轉）。部署無須改前端之碼，惟設環境變 ICE_SERVERS 可也，如：

  ```bash
  ICE_SERVERS='[{"urls":"stun:stun.l.google.com:19302"},{"urls":"turn:turn.example.com:3478","username":"u","credential":"p"}]' npm start
  ```

  前端啟時自 /config.json 讀之，以用於 RTCPeerConnection。

## 項目之構

```
.
├── server.js            # Express 託靜頁 + WebSocket 信令中轉（惟握手，不觸文檔）
├── public/
│   ├── index.html       # 純白至簡之界面
│   ├── style.css        # 至簡之式（白底、黑灰之字、細線、單色進度之條）
│   ├── app.js           # WebRTC 之連、分片之傳、背壓、流式落盤、斷點續傳、二維碼
│   └── vendor/
│       └── qrcode.js    # 本地內置之二維碼生庫（零依，純域網無外網亦能生）
├── package.json
└── package-lock.json
```

## 已治之要（實現之詳）

- **polite 由伺服者分**：完美協商須二方職定，伺服者依入之先後，分一正一反，以絕「二方皆 impolite，互待 answer」之死結。

- **發者串行**：sendQueue 加 pump() 保多檔之傳，meta → 分片 → done 嚴不交錯，收受者用一 recvCtx 以正重組。

- **pump 死結之防**：pump 用 try/finally 保 sending 必復；sendFile 於 arrayBuffer() 異步讀後復查通道之態，斷連之窗內不拋穿透之異。

- **背壓懸之防**：待 bufferedamountlow 之時，兼聽 channel 之 close，對端去不令永懸。

- **connect() 之冪等**：自動重連之定時與手連，不創多 WebSocket。

- **pc.close() 空引用之防**：閉前解其諸事件之 handler，免異步態變讀及已空之 pc。

- **重連歸復之修**：doJoin 優用 joinedRoom，斷而復連能自歸故室。

- **資源之清**：resetConnection 清待發之隊、釋收受端之 Blob URL、依上限收過期之鏈，免內存之積與漏。

- **連態之細分**：disconnected（可自復之暫態）與 failed／closed 分示之。

- **流式落盤**：收受者於 file-meta 後，由用者之手勢觸 showSaveFilePicker，得可寫之流，乃告發者（recv-ready）而後始發分片；分片直 writer.write 落盤，內存恆定。其不支持者退為 Blob 加下載之鏈。

- **斷點續傳（會話內）**：發者用 sendCtxById 留 {file, item} 以備續，resetConnection 不清之；收受端 recvCtx（含可寫之流／已受之偏）於傳中默留；復連後收受之通道 onopen 觸 maybeResume，向發者發 resume-request {id, offset}，發者自斷點續發。

- **二維碼配對**：?room= 之室碼，由 app.js 初化時析之而自入；「生二維碼以邀」之鈕，用本地內置之 qrcode-generator 生入室鏈之碼（QR 之含 location.origin，掃者須能達此伺服之址）。此鈕獨立於入之行列，連前連後皆可按。

- **拒／再試之約**：收受者「拒」則發 recv-reject，發者立以 false 解 waitRecvReady（不再困五刻），且據 ctx.rejected 示「對方拒收」加「再試」；發者諸敗支統經 fail() 補「再試」之入，retryFile(id) 復用 sendCtxById 所留之 file 而重入隊。

- **waitRecvReady 斷連之解**：resetConnection 不復惟清 pendingRecvReady，乃逐 clearTimeout 而以 false resolve，對端去後發者不困於待收受者備，最久五刻。

- **競態之防（通道 await 後之態）**：file-done 之 writer.close() 異步之際，及 addSaveButton 之 showSaveFilePicker 彈窗之際，皆先捕局部之 ctx／recvCtx 之引，await 後復查其引仍是當下之境，免對端去觸 resetConnection 置空而後讀及 null 拋 TypeError。

- **拒後態之合（P0-A）**：收受者「拒」時會同步禁而改「存為…」與「拒」之鈕，且 addSaveButton 之回於存框返後復查 ctx.done——杜「先拒復點存」致 writer 之漏、妄發 recv-ready、收受端入「待數據永不得」之死態。

- **再試不妄報拒（P0-B）**：retryFile 再試前 delete ctx.rejected，故二次逾時（收受既不存亦不拒）準示「對方未存」，而非以前拒之標妄帶而示「對方拒收」。

- **敗支統收（P0-C／P1）**：sendFile 內 arrayBuffer() 異步讀後斷、及 pump 之 catch，統走 fail() 加再試之鈕，杜個支漏再試之入、二處邏輯之漂。

- **隨機串改用 crypto**：室碼（randRoom）與檔 id（fileId，UUIDv4）改用 crypto.getRandomValues 以生，代 Math.random，免檔 id（兼為續傳之鍵）之撞。

- **resetConnection 語義之清**：入參改為 { keepJoinUI, full } 之選項，是否留傳中之檔，由「有未竟之 recvCtx 否」推之，消舊 keepTransfer 被強覆之歧。

- **伺服之韌**：室碼長之校（一至六四，過長回 bad-room）、WebSocketServer 設 maxPayload: 8KB、每連每 1s 之窗百條消息之滑窗限流（JSON.parse 之前計之，非法 JSON 亦計，無由空轉繞之）、send 包 try/catch、客端 ws.onmessage 於非法 JSON 直忽之，皆免域網之無效妄發致白屏或資之竭。

- **CSP 與 ICE 配置之下**：伺服者統設 Content-Security-Policy（default-src 'self'；img-src 白名含 data: 以許 qrcode.js 之 data:image/gif；connect-src 'self' 已括同源 WebSocket，不復許任意 ws:/wss: 之址，收外連注入之面）；新 GET /config.json 透 ICE_SERVERS 之環境變，前端用 iceConfigReady 之 promise 於 createConnection 中 await 而後建 RTCPeerConnection，跨公網加 TURN 無須改前端，且 ?room= 自入時 TURN 之配亦已備。

- **file-done 亡之修（邊界 P1）**：發者發畢分片後 sendChannel.send({type:'file-done'}) 恰於斷連之窗拋錯，則走 fail() 且 sendCtxById 不清，復連後收受端 resume-request 以 offset >= size 見忽、永待不至 file-done 而困百分之百。已於 resume-request 支特處：收受端已受全字節（offset >= size）時，若通道猶開則重發一次 file-done 以竟、刪 sendCtxById，收受端乃成。

- **P3 時序之竟（長尾時序，零險之清，皆依審 diff 落）**：

  - **file-done 之 await writer.close() 之窗**：此支改為先 recvCtx = null 而後 await，免 await 之際同 id 新 file-meta（發者恰此時再試）復用 DOM 妄標新節為「已成」、進度之錯；resetConnection 之 recvCtx && !recvCtx.done 之判，因 null 直短路，不為所動。

  - **maybeResume 於 received === 0 之徑**：已有可寫之流而 received === 0 時，改走 reAddSaveButton（俾用者重擇所存），其義比重發空 file-meta 復為 writer.abort() 奪者直，免鈕「已備→存為…」之往還跳；Blob 兜底之支保持直 resume（空傳無害）。

  - **斷連清空 roomInput 之視抖**：resetConnection 惟用者自去（full:true）時清輸入框，斷連復連不復清（joinedRoom 猶在，復連後自 doJoin）。

- **室之生命週期之補（本輪審）**：

  - **full 不復留孤連**：收 full（室滿）之支，舊惟清 joinedRoom 與入之行，若用者方連於舊室而更入滿員之室，舊 pc 殘為孤連，且此後 WS 之抖無由復連於故室。已補 resetConnection({ full: true })，先斷舊 P2P 而後歸入之界面。

  - **joined 即現去之鈕**：入室（獨待或已連）後立 leaveBtn.hidden = false，中道欲更室直按「去」，無俟刷頁。

  - **onFileMeta 選擇器用 CSS.escape**：lists.querySelector('.item[data-id="..."]') 之 id 經 CSS.escape 處之，禦任意檔 id 壞選擇器（今 id 為 UUIDv4 十六進，實無影響，屬禦之加固）。

  - **createConnection 防併發漏＋防孤 pc（P2）**：await iceConfigReady 之後，先補 if (!ws || ws.readyState !== WebSocket.OPEN) return;（用靜常 WebSocket.OPEN），而後 if (pc) return;。前者堵「iceConfigReady 懸之際 WS 斷而復連」之境——獨以 if (pc) return 猶於此窗創孤 pc，且以 pc 非空缺重連後之 peer-ready 見略、永協不上；新 WS 存之查，使懸復時已斷之呼直返，俟復連 OPEN 而後常建 pc。二者協，常徑零影響。

- **斷連抖留已成之表（邊界 P1）**：resetConnection 之 keepTransfer 舊惟 recvCtx 已 done／為空則清全表，致一暫之 WS 抖盡失已成檔之 UI 與下載之鏈。已改為「有未竟之受，或表中有 .item.done 之條」即留，惟用者自去（full:true）時盡清；既不亡已成之史，亦不於無傳時殘空表。

- **recvUrls revoke 從 keepTransfer（邊界 P2，上輪補之對稱之修）**：上輪以「留已成之史」入 keepTransfer 後，無條件 revokeObjectURL 猶於斷連復連時盡廢所留之「下載」鏈，點之成死鏈。已以 revoke 整段裹於 if (!keepTransfer)，使斷連復連所保之鏈真可用，惟自去（full:true）乃一清；MAX_RECV_URLS = 8 保不 revoke 亦不無界之增。

- **bad-room 孤連（邊界 P2，與 full 對稱）**：handleWs 之 bad-room 支舊惟 resetJoinUI()，當用者方連於舊室 P2P 而輸過長／非法之室碼更室敗，留「WS 不在任何室而 pc 猶連」之孤連。已與 full 支一，改 resetConnection({ full: true })（內調 resetJoinUI），先斷舊 P2P 而後示，免去後無由自復連。

- **再試復用 DOM 之條（邊界 P2）**：收受端 onFileMeta 受同 id 之 file-meta（發者按「再試」重發、id 不變）時，舊會新第二 DOM 節，表現二同名同大之項。已改為先查 lists.querySelector('.item[data-id="<id>"]')，中則復用原條（清 done、進度歸零、去舊操作之區）而後受；且順於 addItem 補 item.dataset.id = id（前 id 之參未用，既為修所需亦去此碼之異）。

## 所限／所圖

- **大檔之內存**：於安全之境（HTTPS / localhost）已以流式落盤解之；然經 HTTP 域網 IP 而訪（非 localhost）時，瀏覽器不與 File System Access API，自退為 Blob 全量之緩，GB 之巨猶佔內存。須 HTTPS 乃享流式落盤。

- **斷點續傳之域**：惟限「同頁之會話內」斷而復連。刷頁後檔之柄／可寫之流亡，須從頭重傳（File System Access 之權不可跨越刷新而復，且未引 IndexedDB 之持久）。

- **跨公網**：須補 TURN 之配。

- **可迭代之能**：刷後持久續傳（IndexedDB）、資料夾整體之傳。

## 自動之驗

項目附真瀏覽器端到端之測（Playwright + 無頭 Chromium），覆靜審所不能發之運時之患：

- **基礎之鏈**：二端經本機信令伺服立 WebRTC P2P 之連、二維碼之生、1MB 檔之傳且受之內容與原檔逐字節合、發者進度條達百分之百、二端無任何主控台之誤。

- **斷點續傳（真境）**：10MB 檔傳中假 setOffline 以擬網之分隔，二端自復連而自斷點續傳，檔猶逐字節合、態復為已連。

- **拒／再試／CSP**：收受者「拒」後發者立現「對方拒收」而現「再試」之鈕，按再試可重提（收受端復現存之鈕）；經 File System Access 之徑（注偽 showSaveFilePicker）驗流式落盤「已存於本地」；二維碼於 CSP 下用 data:image/gif 常生，全程零主控台之誤。

- **競態之專（P0-A）**：注可控之 showSaveFilePicker，擬「先點存（彈窗懸）→ 存框待之際點拒 → 彈窗乃返」之競態，驗修後不創 writer、不向發者發 recv-ready，收受端留於「已拒」。

- **再試妄報之專（P0-B）**：以 RECV_READY_TIMEOUT 暫縮至 2s，驗「拒 → 再試 → 收受端不為直至逾時」終示「對方未存」而非妄報「對方拒收」。

- **敗收之專（P0-C／P1）**：惟發者入室即列檔於隊，驗 sendFile 立走 fail() 示「連已斷」而給「再試」之鈕；俟第二端入而按再試，重立連而傳成（流式落盤「已存於本地」）。

測中所發而修之患：連後「二維碼」之鈕以位於被禁之入行內而「可見而不可點」，已移出入行，改為隨時可點之「生二維碼以邀」。

> 說：測為除「手勢存框」於自動之擾，強走 Blob 兜底之徑以驗數據面之正；流式落盤（File System Access）與「手勢存框」之交，猶須於支持該 API 之真瀏覽器中手驗。

本輪新之三邊界之修（一 file-done 於斷連之窗亡、二 斷連抖清已成之表、三 同 id 再試重條）皆屬「斷連之一瞬恰至某 await／恰用者點再試」之級之長尾之境，難以穩 E2E 復（自動觸「file-done 恰於 DataChannel 閉那一刻 send 拋誤」甚 flaky）。故本輪以精確邏輯之復核加 node --check 語法之校加全量回歸既 E2E 猶零主控台之誤為準：改皆局部分支之調，未觸已驗之主幹之鏈（完美協商、背壓、流式落盤、斷點續傳、拒收、再試、CSP、限流），故既 P0/A/B/C 與 P1 之為不動。

## 許可

[MIT](LICENSE)
