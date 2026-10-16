const map = L.map('map').setView([35.1029, 138.8597], 15);

L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
}).addTo(map);

const redIcon = L.divIcon({ className: 'smoking-icon icon-red', html: 'smoking_rooms', iconSize: [30, 30], iconAnchor: [15, 15] });
const blueIcon = L.divIcon({ className: 'smoking-icon icon-blue', html: 'smoking_rooms', iconSize: [30, 30], iconAnchor: [15, 15] });
const elecPurpleRedIcon = L.divIcon({ className: 'smoking-icon icon-elec-purple-red', html: 'smoking_rooms', iconSize: [30, 30], iconAnchor: [15, 15] });
const elecPurpleBlueIcon = L.divIcon({ className: 'smoking-icon icon-elec-purple-blue', html: 'smoking_rooms', iconSize: [30, 30], iconAnchor: [15, 15] });

const shopNearIcon = L.divIcon({ className: 'smoking-icon icon-shop-near', html: 'storefront', iconSize: [30, 30], iconAnchor: [15, 15] });
const shopFarIcon = L.divIcon({ className: 'smoking-icon icon-shop-far', html: 'storefront', iconSize: [30, 30], iconAnchor: [15, 15] });

const convNearIcon = L.divIcon({ className: 'smoking-icon icon-conv-near', html: 'local_convenience_store', iconSize: [30, 30], iconAnchor: [15, 15] });
const convFarIcon = L.divIcon({ className: 'smoking-icon icon-conv-far', html: 'local_convenience_store', iconSize: [30, 30], iconAnchor: [15, 15] });

const customNearIcon = L.divIcon({ className: 'smoking-icon icon-custom-near', html: 'add_location_alt', iconSize: [30, 30], iconAnchor: [15, 15] });
const customFarIcon = L.divIcon({ className: 'smoking-icon icon-custom-far', html: 'add_location_alt', iconSize: [30, 30], iconAnchor: [15, 15] });

const personIconHtml = `
    <div style="position: relative;">
        <div id="direction-cone" style="display: none; position: absolute; top: -33px; left: -13px; width: 0; height: 0; border-left: 30px solid transparent; border-right: 30px solid transparent; border-top: 50px solid rgba(52, 152, 219, 0.4); transform-origin: 30px 50px; pointer-events: none; z-index: -1;"></div>
        <div style="position: relative; width: 34px; height: 34px; background-color: #3498db; color: white; border-radius: 50%; display: flex; justify-content: center; align-items: center; box-shadow: 0 2px 5px rgba(0,0,0,0.5); border: 2px solid white; z-index: 1;">
            <span class="material-icons" style="font-size: 20px;">directions_walk</span>
        </div>
    </div>
`;
const personIcon = L.divIcon({ className: '', html: personIconHtml, iconSize: [34, 34], iconAnchor: [17, 17] });

const markerGroup = L.layerGroup().addTo(map);

let userLocation = null;
let userCircle = null;
let userMarker = null;
let watchId = null;
let isFirstLocation = true;

let isPopupOpen = false;
map.on('popupopen', function() { isPopupOpen = true; });
map.on('popupclose', function() { isPopupOpen = false; });

let routingControl = null;
let navigatingDestination = null;
let hasNotifiedArrival = false;

// === マルチルート管理用データ構造 ===
let foundRoutes = [];
let selectedRouteIndex = 0;
let activePolylineLayer = null;

// === リルート（離脱検知）用変数 ===
let offRouteCount = 0;
let isRerouting = false;
const OFF_ROUTE_THRESHOLD_METERS = 25; // 離脱とみなす距離（メートル）
const OFF_ROUTE_CONFIRM_COUNT = 3;      // 誤検知防止のための連続検知回数

function showArrivalModal() {
    const modal = document.getElementById('arrival-modal');
    if (modal) modal.style.display = 'flex';
}

function dismissArrivalModal() {
    const modal = document.getElementById('arrival-modal');
    if (modal) modal.style.display = 'none';
}

function confirmArrivalFinish() {
    dismissArrivalModal();
    clearRoute();
}

// ====== 点と線分の最短距離（メートル）を計算するヘルパー関数 ======
function getDistanceToSegment(p, p1, p2) {
    const x = p.lng, y = p.lat;
    const x1 = p1.lng, y1 = p1.lat;
    const x2 = p2.lng, y2 = p2.lat;

    const dx = x2 - x1;
    const dy = y2 - y1;

    if (dx === 0 && dy === 0) {
        return p.distanceTo(p1);
    }

    const t = ((x - x1) * dx + (y - y1) * dy) / (dx * dx + dy * dy);
    const clampedT = Math.max(0, Math.min(1, t));

    const nearestPoint = L.latLng(
        y1 + clampedT * dy,
        x1 + clampedT * dx
    );

    return p.distanceTo(nearestPoint);
}

// ====== 通過済みルートの消去（現在地より前のルート線を取り除く） ======
function updatePassedRoute(currentLatLng) {
    if (!activePolylineLayer || !foundRoutes[selectedRouteIndex] || isRerouting) return;

    const currentRoute = foundRoutes[selectedRouteIndex];
    if (!currentRoute.coordinates || currentRoute.coordinates.length < 2) return;

    const coords = currentRoute.coordinates;
    let closestIndex = 0;
    let minDistance = Infinity;

    // 現在地に最も近いルート上の点を探索
    for (let i = 0; i < coords.length; i++) {
        const point = L.latLng(coords[i].lat, coords[i].lng);
        const dist = currentLatLng.distanceTo(point);
        if (dist < minDistance) {
            minDistance = dist;
            closestIndex = i;
        }
    }

    // 許容範囲内（例: 30m以内）にいる場合、通過した点を除いた残りのルートのみで描画し直す
    if (minDistance <= 30 && closestIndex > 0) {
        // 現在地を出発点として残りの座標リストを作成
        const remainingCoords = [
            [currentLatLng.lat, currentLatLng.lng],
            ...coords.slice(closestIndex).map(c => [c.lat, c.lng])
        ];
        activePolylineLayer.setLatLngs(remainingCoords);
    }
}

// ====== ルート離脱チェック＆自動再計算（リルート） ======
function checkOffRoute(currentLatLng) {
    if (!navigatingDestination || !foundRoutes[selectedRouteIndex] || isRerouting) return;

    const currentRoute = foundRoutes[selectedRouteIndex];
    if (!currentRoute.coordinates || currentRoute.coordinates.length < 2) return;

    const coords = currentRoute.coordinates;
    let minDistance = Infinity;

    // 現在地からルート上の最も近い線分までの距離を探索
    for (let i = 0; i < coords.length - 1; i++) {
        const p1 = L.latLng(coords[i].lat, coords[i].lng);
        const p2 = L.latLng(coords[i + 1].lat, coords[i + 1].lng);
        const dist = getDistanceToSegment(currentLatLng, p1, p2);
        if (dist < minDistance) {
            minDistance = dist;
        }
    }

    // 閾値を超えているか判定
    if (minDistance > OFF_ROUTE_THRESHOLD_METERS) {
        offRouteCount++;
        if (offRouteCount >= OFF_ROUTE_CONFIRM_COUNT) {
            isRerouting = true;
            offRouteCount = 0;
            
            console.log("ルートを外れたため再検索します...");
            
            // 新しい現在地から目的地までのルートを自動再検索
            showRouteTo(navigatingDestination.lat, navigatingDestination.lng);
        }
    } else {
        offRouteCount = 0;
    }
}

// ====== マルチルート検索・描画機能（選択したルートのみ表示） ======
function showRouteTo(destLat, destLng) {
    let startLatLng = userLocation || map.getCenter();

    // 既存レイヤーとコントロールを破棄（目的地の navigatingDestination は保持）
    if (activePolylineLayer) {
        map.removeLayer(activePolylineLayer);
        activePolylineLayer = null;
    }
    if (routingControl !== null) {
        map.removeControl(routingControl);
        routingControl = null;
    }

    routingControl = L.Routing.control({
        waypoints: [
            L.latLng(startLatLng.lat, startLatLng.lng),
            L.latLng(destLat, destLng)
        ],
        router: L.Routing.osrmv1({
            profile: 'foot',
            serviceUrl: 'https://router.project-osrm.org/route/v1'
        }),
        showAlternatives: true,
        addWaypoints: false,
        draggableWaypoints: false,
        show: false,
        lineOptions: {
            styles: [{ opacity: 0, weight: 0 }],
            extendToWaypoints: false,
            missingRouteTolerance: 0
        },
        altLineOptions: {
            styles: [{ opacity: 0, weight: 0 }],
            extendToWaypoints: false,
            missingRouteTolerance: 0
        }
    }).addTo(map);

    if (routingControl._line) {
        map.removeLayer(routingControl._line);
    }

    routingControl.on('routesfound', function(e) {
        if (routingControl._line) map.removeLayer(routingControl._line);
        if (routingControl._alternativeLines) {
            routingControl._alternativeLines.forEach(line => map.removeLayer(line));
        }

        foundRoutes = e.routes;
        selectedRouteIndex = 0;
        offRouteCount = 0;
        isRerouting = false; // リルート完了
        
        renderRouteSelectorCards();
        drawSingleSelectedRoute(0);
    });

    routingControl.on('routingerror', function() {
        isRerouting = false;
    });

    map.closePopup();

    navigatingDestination = L.latLng(destLat, destLng);
    hasNotifiedArrival = false;
    const cancelBtn = document.getElementById('cancel-route-btn');
    if (cancelBtn) cancelBtn.style.display = 'block';
}

function drawSingleSelectedRoute(index) {
    if (activePolylineLayer) {
        map.removeLayer(activePolylineLayer);
        activePolylineLayer = null;
    }

    if (routingControl) {
        if (routingControl._line) map.removeLayer(routingControl._line);
        if (routingControl._alternativeLines) {
            routingControl._alternativeLines.forEach(line => map.removeLayer(line));
        }
    }

    const route = foundRoutes[index];
    if (route && route.coordinates) {
        const latLngs = route.coordinates.map(coord => [coord.lat, coord.lng]);
        activePolylineLayer = L.polyline(latLngs, {
            color: '#27ae60',
            weight: 7,
            opacity: 0.9
        }).addTo(map);
    }
}

// ルート選択用カード描画（画面右下・現在地ボタンの上に配置・時間非表示）
function renderRouteSelectorCards() {
    let container = document.getElementById('route-selector-container');
    if (!container) {
        container = document.createElement('div');
        container.id = 'route-selector-container';
        container.style.cssText = 'position: absolute; bottom: 85px; right: 20px; z-index: 1000; display: flex; gap: 10px; overflow-x: auto; padding: 5px; max-width: calc(100% - 40px);';
        document.body.appendChild(container);
    }
    container.innerHTML = '';

    foundRoutes.forEach((route, index) => {
        const isSelected = index === selectedRouteIndex;
        const distanceMeters = Math.round(route.summary.totalDistance);

        const card = document.createElement('div');
        card.style.cssText = `
            background: ${isSelected ? '#e8f8f5' : '#ffffff'};
            border: 2px solid ${isSelected ? '#27ae60' : '#bdc3c7'};
            border-radius: 8px;
            padding: 10px 16px;
            min-width: 120px;
            cursor: pointer;
            box-shadow: 0 2px 6px rgba(0,0,0,0.2);
            transition: all 0.2s ease;
            text-align: center;
            flex-shrink: 0;
        `;

        card.innerHTML = `
            <div style="font-weight: bold; font-size: 14px; color: ${isSelected ? '#27ae60' : '#333'};">ルート ${index + 1}${index === 0 ? ' (最短)' : ''}</div>
            <div style="font-size: 12px; color: #555; margin-top: 4px;">約 ${distanceMeters} m</div>
        `;

        card.onclick = () => selectRoute(index);
        container.appendChild(card);
    });
}

function selectRoute(index) {
    selectedRouteIndex = index;
    offRouteCount = 0; // 手動でルート変更した場合はカウンターリセット
    drawSingleSelectedRoute(index);
    renderRouteSelectorCards();
}

function clearRoute() {
    if (activePolylineLayer) {
        map.removeLayer(activePolylineLayer);
        activePolylineLayer = null;
    }

    if (routingControl !== null) {
        map.removeControl(routingControl);
        routingControl = null;
        navigatingDestination = null;
        hasNotifiedArrival = false;
        foundRoutes = [];
        offRouteCount = 0;
        isRerouting = false;

        const cancelBtn = document.getElementById('cancel-route-btn');
        if (cancelBtn) cancelBtn.style.display = 'none';

        const container = document.getElementById('route-selector-container');
        if (container) container.remove();
    }
}

function handleOrientation(event) {
    let heading = null;
    if (event.webkitCompassHeading != null) {
        heading = event.webkitCompassHeading;
    } else if (event.alpha != null) {
        heading = 360 - event.alpha;
    }

    if (heading !== null) {
        const cone = document.getElementById('direction-cone');
        if (cone) {
            cone.style.display = 'block';
            cone.style.transform = `rotate(${heading}deg)`;
        }
    }
}

let compassInitialized = false;
function initCompass() {
    if (compassInitialized) return;
    if (typeof DeviceOrientationEvent !== 'undefined') {
        if (typeof DeviceOrientationEvent.requestPermission === 'function') {
            DeviceOrientationEvent.requestPermission()
            .then(permissionState => {
                if (permissionState === 'granted') {
                    window.addEventListener('deviceorientation', handleOrientation);
                    compassInitialized = true;
                }
            }).catch(console.error);
        } else {
            window.addEventListener('deviceorientation', handleOrientation);
            compassInitialized = true;
        }
    }
}

document.addEventListener('click', initCompass, { once: true });
document.addEventListener('touchstart', initCompass, { once: true });

function locateUser() {
    if (!navigator.geolocation) return;

    watchId = navigator.geolocation.watchPosition(
        (position) => {
            const lat = position.coords.latitude;
            const lng = position.coords.longitude;
            userLocation = L.latLng(lat, lng);

            if (isFirstLocation) {
                map.setView(userLocation, 16);
                isFirstLocation = false;
            }

            if (userCircle) {
                userCircle.setLatLng(userLocation);
            } else {
                userCircle = L.circle(userLocation, {
                    color: '#3498db', fillColor: '#3498db', fillOpacity: 0.1, radius: 500
                }).addTo(map);
            }

            if (userMarker) {
                userMarker.setLatLng(userLocation);
            } else {
                userMarker = L.marker(userLocation, {icon: personIcon}).addTo(map);
            }

            if (navigatingDestination && !hasNotifiedArrival) {
                const distanceToDest = userLocation.distanceTo(navigatingDestination);
                if (distanceToDest <= 20) {
                    hasNotifiedArrival = true;
                    showArrivalModal();
                } else {
                    // 通過した分のルート線を消去
                    updatePassedRoute(userLocation);
                    // 到着していない場合はルート離脱を自動検知
                    checkOffRoute(userLocation);
                }
            }
        },
        (error) => console.log("現在地が取得できません。"),
        { enableHighAccuracy: true, maximumAge: 0, timeout: 10000 }
    );
}

const locateControl = L.control({position: 'bottomright'});
locateControl.onAdd = function(map) {
    const btn = L.DomUtil.create('button', 'locate-btn');
    btn.innerHTML = '<span class="material-icons">my_location</span>';
    btn.style.cssText = 'background-color: white; border: none; border-radius: 50%; width: 45px; height: 45px; cursor: pointer; box-shadow: 0 2px 5px rgba(0,0,0,0.3); display: flex; justify-content: center; align-items: center; margin-bottom: 20px; margin-right: 10px; color: #666;';

    btn.onclick = function() {
        if (userLocation) {
            map.setView(userLocation, 16);
        } else {
            alert("現在地を取得中です。少しお待ちください。");
        }
        initCompass();
    };
    return btn;
};
locateControl.addTo(map);

async function reportCongestion(placeId, status) {
    const userId = localStorage.getItem('current_user_id');
    if (!userId) {
        alert("混雑状況の報告にはログインが必要です。");
        return;
    }

    try {
        const response = await fetch('http://localhost:3000/api/congestion', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                userId: userId,
                placeId: String(placeId),
                status: status
            })
        });

        const data = await response.json();

        if (response.ok) {
            alert(data.message || "混雑状況を報告しました！ありがとうございます。");
            map.closePopup();
        } else {
            alert(data.message || "報告の送信に失敗しました。");
        }
    } catch (error) {
        console.error("送信エラー:", error);
        alert("サーバー通信エラーが発生しました。");
    }
}

// ====== 喫煙所データの取得 ======
async function loadSmokingAreas() {
    if (map.getZoom() < 13) return;
    if (isPopupOpen) return;

    const bounds = map.getBounds();
    const query = `[out:json][timeout:25];(node["amenity"="smoking_area"](${bounds.getSouth()},${bounds.getWest()},${bounds.getNorth()},${bounds.getEast()});node["shop"="tobacco"](${bounds.getSouth()},${bounds.getWest()},${bounds.getNorth()},${bounds.getEast()});node["shop"="convenience"](${bounds.getSouth()},${bounds.getWest()},${bounds.getNorth()},${bounds.getEast()}););out;`;
    const url = `https://overpass-api.de/api/interpreter?data=${encodeURIComponent(query)}`;

    try {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`HTTP Error: ${response.status}`);
        const data = await response.json();
        
        markerGroup.clearLayers();

        data.elements.forEach(element => {
            if (element.lat && element.lon) {
                const smokingLocation = L.latLng(element.lat, element.lon);
                const isShop = element.tags && element.tags.shop === 'tobacco';
                const isConv = element.tags && element.tags.shop === 'convenience';
                
                let name = '喫煙所';
                if (element.tags && element.tags.name) name = element.tags.name;
                else if (isShop) name = 'たばこ販売店';
                else if (isConv) name = 'コンビニ';

                const note = element.tags && element.tags.note ? element.tags.note : '';
                const desc = element.tags && element.tags.description ? element.tags.description : '';
                const elecTag = element.tags && element.tags.electronic_cigarettes ? element.tags.electronic_cigarettes : '';
                const smokingTag = element.tags && element.tags.smoking ? element.tags.smoking : '';

                let isElecOnly = false;
                if (!isShop && !isConv && (name.includes('加熱式') || name.includes('電子') || name.includes('アイコス') ||
                    note.includes('加熱式') || note.includes('電子') || desc.includes('加熱式') || desc.includes('電子') ||
                    elecTag === 'only' || elecTag === 'yes' || smokingTag === 'electronic_cigarettes')) {
                    isElecOnly = true;
                }
                
                let distance = Infinity;
                let selectedIcon = isConv ? convFarIcon : (isShop ? shopFarIcon : (isElecOnly ? elecPurpleBlueIcon : blueIcon));

                if (userLocation) {
                    distance = map.distance(userLocation, smokingLocation);
                    if (distance <= 500) {
                        selectedIcon = isConv ? convNearIcon : (isShop ? shopNearIcon : (isElecOnly ? elecPurpleRedIcon : redIcon));
                    }
                }

                const marker = L.marker(smokingLocation, {icon: selectedIcon});
                marker.bindPopup('<div style="text-align:center;">読み込み中...</div>');
                
                marker.on('popupopen', async function(e) {
                    const popup = e.popup;
                    const safeName = name.replace(/'/g, "\\'").replace(/"/g, '&quot;');
                    const userId = localStorage.getItem('current_user_id');
                    const placeIdStr = String(element.id);

                    let isFav = false;
                    let congestionInfo = { summary: 'データなし', totalReports: 0 };

                    try {
                        const [favRes, congRes] = await Promise.all([
                            userId ? fetch(`http://localhost:3000/api/favorites/places/${userId}`) : Promise.resolve(null),
                            fetch(`http://localhost:3000/api/congestion/${placeIdStr}`)
                        ]);

                        if (favRes && favRes.ok) {
                            const currentPlaces = await favRes.json();
                            if (Array.isArray(currentPlaces)) {
                                isFav = currentPlaces.some(p => String(p.place_id) === placeIdStr);
                            }
                        }

                        if (congRes && congRes.ok) {
                            congestionInfo = await congRes.json();
                        }
                    } catch (err) {
                        console.error("データ取得エラー:", err);
                    }

                    let popupText = `<div style="font-size:14px; min-width:220px;"><b>${name}</b>`;
                    if (isConv) popupText += `<br><span style="color:#2980b9; font-size:12px; font-weight:bold;">※コンビニ</span>`;
                    else if (isShop) popupText += `<br><span style="color:#27ae60; font-size:12px; font-weight:bold;">※たばこ店</span>`;
                    else if (isElecOnly) popupText += `<br><span style="color:#8e44ad; font-size:12px; font-weight:bold;">※加熱式・電子専用</span>`;

                    if (distance !== Infinity) popupText += `<br><span style="color:#555; font-size:12px;">ここから約 ${Math.round(distance)}m</span>`;

                    popupText += `
                        <div style="margin-top:8px; padding:8px; background:#f8f9fa; border-radius:6px; text-align:center;">
                            <div style="font-size:12px; color:#666;">直近2時間の混雑状況</div>
                            <div style="font-size:15px; font-weight:bold; margin:3px 0;">${congestionInfo.summary} <span style="font-size:11px; font-weight:normal; color:#888;">(${congestionInfo.totalReports}件の報告)</span></div>
                            
                            <div style="margin-top:6px; display:flex; gap:4px; justify-content:center;">
                                <button onclick="reportCongestion('${element.id}', 'smooth')" style="font-size:10px; padding:3px 6px; cursor:pointer; background:#e8f8f5; border:1px solid #2ecc71; border-radius:4px; color:#27ae60;">🔵 空いている</button>
                                <button onclick="reportCongestion('${element.id}', 'normal')" style="font-size:10px; padding:3px 6px; cursor:pointer; background:#fef9e7; border:1px solid #f1c40f; border-radius:4px; color:#d35400;">🟡 普通</button>
                                <button onclick="reportCongestion('${element.id}', 'crowded')" style="font-size:10px; padding:3px 6px; cursor:pointer; background:#fadbd8; border:1px solid #e74c3c; border-radius:4px; color:#c0392b;">🔴 混雑</button>
                            </div>
                        </div>
                    `;

                    popupText += `<div style="margin-top:10px; text-align:center;">
                        <button onclick="showRouteTo(${element.lat}, ${element.lon})" style="width:100%; cursor:pointer; padding:6px 12px; border-radius:4px; border:none; background:#27ae60; color:white; font-weight:bold; font-size:12px;">🚶♂️ ルートを調べる</button>
                    </div>`;

                    popupText += `<hr style="margin:10px 0;"><div style="text-align:center;">`;

                    if (isFav) {
                        popupText += `<button onclick="toggleFavorite(${element.id}, '${safeName}', ${element.lat}, ${element.lon})" style="cursor:pointer; padding:8px 15px; border-radius:20px; border:1px solid #e74c3c; background:#e74c3c; color:white; font-weight:bold; font-size:12px;">❌ お気に入り解除</button>`;
                    } else {
                        popupText += `<button onclick="toggleFavorite(${element.id}, '${safeName}', ${element.lat}, ${element.lon})" style="cursor:pointer; padding:8px 15px; border-radius:20px; border:1px solid #ccc; background:white; color:#333; font-size:12px;">⭐ お気に入りに保存</button>`;
                    }

                    popupText += `</div></div>`;

                    popup.setContent(popupText);
                });
                
                markerGroup.addLayer(marker);
            }
        });
    } catch (error) {
        console.error('データの取得に失敗しました:', error);
    }
    loadCustomPins();
}

map.on('moveend', loadSmokingAreas);
loadSmokingAreas();
locateUser();

// ====== 認証（ログイン・新規登録・ログアウト）機能 ======
let authMode = 'login';

function switchAuthTab(mode) {
    authMode = mode;
    const tabLogin = document.getElementById('tab-login');
    const tabRegister = document.getElementById('tab-register');
    const submitBtn = document.getElementById('auth-submit-btn');
    const hint = document.getElementById('auth-hint');

    if (mode === 'login') {
        tabLogin.classList.add('active');
        tabRegister.classList.remove('active');
        submitBtn.textContent = 'ログイン';
        hint.textContent = '登録済みのユーザー名とパスワードを入力してください';
    } else {
        tabRegister.classList.add('active');
        tabLogin.classList.remove('active');
        submitBtn.textContent = '新規ユーザー登録';
        hint.textContent = 'ご希望のユーザー名とパスワードを入力して登録します';
    }
}

async function handleAuthSubmit() {
    const username = document.getElementById('login-username').value.trim();
    const password = document.getElementById('login-password').value.trim();

    if (!username || !password) {
        alert("ユーザー名とパスワードを入力してください。");
        return;
    }

    const endpoint = authMode === 'login' ? '/api/login' : '/api/register';

    try {
        const response = await fetch(`http://localhost:3000${endpoint}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password })
        });

        const data = await response.json();

        if (response.ok) {
            if (authMode === 'login') {
                localStorage.setItem('current_user_id', data.user.id);
                localStorage.setItem('current_user_name', data.user.username);
                alert(`${data.user.username} さんでログインしました！`);
                document.getElementById('login-modal').style.display = 'none';
                loadCustomPins();
            } else {
                alert('新規登録が完了しました！ログインしてください。');
                switchAuthTab('login');
            }
            if (typeof map !== 'undefined') map.invalidateSize();
        } else {
            alert(`エラー: ${data.message || '認証に失敗しました'}`);
        }
    } catch (error) {
        console.error('通信エラー:', error);
        alert('サーバーに接続できませんでした。');
    }
}

function handleLogout() {
    if (confirm("ログアウトしますか？")) {
        localStorage.removeItem('current_user_id');
        localStorage.removeItem('current_user_name');

        document.getElementById('login-username').value = '';
        document.getElementById('login-password').value = '';

        const loginModal = document.getElementById('login-modal');
        if (loginModal) loginModal.style.display = 'flex';
        switchAuthTab('login');
        loadCustomPins();
        alert("ログアウトしました。");
    }
}

// ====== お気に入り銘柄機能 ======
function toggleBrandModal() {
    const modal = document.getElementById('brand-modal');
    if (modal.style.display === "block") {
        modal.style.display = "none";
    } else {
        modal.style.display = "block";
        displayBrands();
    }
}

async function displayBrands() {
    const userId = localStorage.getItem('current_user_id');
    const container = document.getElementById('brand-list-container');
    container.innerHTML = "";

    if (!userId) {
        container.innerHTML = "<p style='color:#666;'>ログインしてください。</p>";
        return;
    }

    try {
        const response = await fetch(`http://localhost:3000/api/favorites/brands/${userId}`);
        const brands = await response.json();

        if (brands.length === 0) {
            container.innerHTML = "<p style='color:#666;'>お気に入りの銘柄はまだ登録されていません。</p>";
            return;
        }

        brands.forEach((brand) => {
            const item = document.createElement('div');
            item.className = 'brand-item';
            item.innerHTML = `
                <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 10px; border-bottom: 1px solid #eee; padding-bottom: 8px;">
                    <div>
                        <h3 style="margin: 0 0 5px 0;">${brand.name}</h3>
                        <p style="margin: 0; font-size: 13px; color: #555;">メーカー: ${brand.company || '不明'} | 価格: ${brand.price || '未設定'}</p>
                        <p style="margin: 5px 0 0 0; font-size: 13px; color: #777;">${brand.description || ''}</p>
                    </div>
                    <button onclick="deleteBrand(${brand.id})" style="background-color: #e74c3c; color: white; border: none; padding: 5px 10px; border-radius: 4px; cursor: pointer;">削除</button>
                </div>
            `;
            container.appendChild(item);
        });
    } catch (error) {
        console.error('銘柄の取得に失敗しました:', error);
    }
}

async function addBrand() {
    const userId = localStorage.getItem('current_user_id');
    if (!userId) {
        alert("ログインが必要です。");
        return;
    }

    const nameInput = document.getElementById('new-brand-name');
    const companyInput = document.getElementById('new-brand-company');
    const priceInput = document.getElementById('new-brand-price');
    const descInput = document.getElementById('new-brand-desc');

    if (!nameInput.value.trim()) {
        alert("銘柄名を入力してください。");
        return;
    }

    try {
        const response = await fetch('http://localhost:3000/api/favorites/brands', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                userId: userId,
                name: nameInput.value.trim(),
                company: companyInput.value.trim(),
                price: priceInput.value.trim() ? priceInput.value.trim() + '円' : '',
                desc: descInput.value.trim()
            })
        });

        if (response.ok) {
            alert("銘柄を追加しました！");
            nameInput.value = "";
            companyInput.value = "";
            priceInput.value = "";
            descInput.value = "";
            displayBrands();
        } else {
            alert("保存に失敗しました。");
        }
    } catch (error) {
        console.error('エラー:', error);
    }
}

async function deleteBrand(brandId) {
    if (!confirm("この銘柄を削除しますか？")) return;

    try {
        const response = await fetch(`http://localhost:3000/api/favorites/brands/${brandId}`, {
            method: 'DELETE'
        });

        if (response.ok) {
            displayBrands();
        } else {
            alert("削除に失敗しました。");
        }
    } catch (error) {
        console.error('エラー:', error);
    }
}

// ====== お気に入り場所機能 ======
async function toggleFavorite(id, name, lat, lon) {
    const userId = localStorage.getItem('current_user_id');
    if (!userId) {
        alert("ログインが必要です。");
        return;
    }

    const stringId = String(id);

    try {
        const checkRes = await fetch(`http://localhost:3000/api/favorites/places/${userId}`);
        const currentPlaces = await checkRes.json();
        
        const existing = Array.isArray(currentPlaces) && currentPlaces.find(p => String(p.place_id) === stringId);

        if (existing) {
            if (confirm(`「${name}」はお気に入りに登録済みです。\n解除しますか？`)) {
                const deleteRes = await fetch('http://localhost:3000/api/favorites/places', {
                    method: 'DELETE',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ userId: userId, placeId: stringId })
                });

                if (deleteRes.ok) {
                    alert("お気に入りから解除しました！");
                    map.closePopup();
                } else {
                    alert("解除に失敗しました。");
                }
            }
        } else {
            const memo = prompt("場所のメモを入力してください：", "お気に入り");
            if (memo === null) return;

            const addRes = await fetch('http://localhost:3000/api/favorites/places', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    userId: userId,
                    placeId: stringId,
                    name: name,
                    lat: lat,
                    lon: lon,
                    memo: memo
                })
            });

            if (addRes.ok) {
                alert("お気に入りに保存しました！");
                map.closePopup();
            } else {
                alert("保存に失敗しました。");
            }
        }
    } catch (error) {
        console.error('エラー:', error);
        alert('通信エラーが発生しました。');
    }
}

function toggleFavModal() {
    const modal = document.getElementById('fav-modal');
    if (modal.style.display === "block") {
        modal.style.display = "none";
    } else {
        modal.style.display = "block";
        displayFavorites();
    }
}

async function displayFavorites() {
    const userId = localStorage.getItem('current_user_id');
    const container = document.getElementById('fav-list-container');
    container.innerHTML = "";

    if (!userId) {
        container.innerHTML = "<p>ログインしてください。</p>";
        return;
    }

    try {
        const response = await fetch(`http://localhost:3000/api/favorites/places/${userId}`);
        const places = await response.json();

        if (places.length === 0) {
            container.innerHTML = "<p>保存した場所はまだありません。</p>";
            return;
        }

        places.forEach(fav => {
            const item = document.createElement('div');
            item.className = 'brand-item';
            item.innerHTML = `
                <h3>⭐ ${fav.name}</h3>
                <p style="font-size: 14px; color: #555; margin-bottom: 10px;">📍 ${fav.memo || 'メモなし'}</p>
                <p style="display:flex; gap:5px;">
                    <button onclick="map.setView([${fav.lat}, ${fav.lon}], 17); toggleFavModal();" style="padding:5px; cursor:pointer;">この場所を見る</button>
                    <button onclick="showRouteTo(${fav.lat}, ${fav.lon}); toggleFavModal();" style="padding:5px; cursor:pointer; background:#27ae60; color:white; border:none; border-radius:3px;">🚶 ルート表示</button>
                </p>
            `;
            container.appendChild(item);
        });
    } catch (error) {
        console.error('データの取得に失敗しました:', error);
    }
}

// ====== カスタムピン機能（MySQL・ユーザー別連動） ======
const customPinGroup = L.layerGroup().addTo(map);
let isAddPinMode = false;

async function loadCustomPins() {
    const userId = localStorage.getItem('current_user_id');
    customPinGroup.clearLayers();

    if (!userId) return;

    try {
        const response = await fetch(`http://localhost:3000/api/custom-places/${userId}`);
        if (!response.ok) return;

        const pins = await response.json();

        pins.forEach(pin => {
            const pinLoc = L.latLng(pin.lat, pin.lon);
            let distance = Infinity;
            let selectedIcon = customFarIcon;

            if (userLocation) {
                distance = map.distance(userLocation, pinLoc);
                if (distance <= 500) {
                    selectedIcon = customNearIcon;
                }
            }

            const marker = L.marker(pinLoc, { icon: selectedIcon });

            let popupText = `<div style="font-size:14px; min-width:200px;"><b>${pin.memo}</b>`;
            popupText += `<br><span style="color:#f39c12; font-size:12px; font-weight:bold;">※あなたが追加した喫煙所</span>`;
            if (distance !== Infinity) popupText += `<br><span style="color:#555; font-size:12px;">ここから約 ${Math.round(distance)}m</span>`;

            popupText += `<div style="margin-top:10px; text-align:center;">
                <button onclick="showRouteTo(${pin.lat}, ${pin.lon})" style="width:100%; cursor:pointer; padding:6px 12px; border-radius:4px; border:none; background:#27ae60; color:white; font-weight:bold; font-size:12px;">🚶 ここへのルートを調べる</button>
            </div>`;

            popupText += `<hr style="margin:10px 0;"><div style="text-align:center;">`;
            popupText += `<button onclick="deleteCustomPin(${pin.id})" style="cursor:pointer; padding:6px 12px; border-radius:20px; border:1px solid #ccc; background:white; color:#e74c3c; font-size:12px;">❌ このピンを削除</button>`;
            popupText += `</div></div>`;

            marker.bindPopup(popupText);
            customPinGroup.addLayer(marker);
        });
    } catch (error) {
        console.error('独自喫煙所の取得エラー:', error);
    }
}

function toggleAddPinMode() {
    const userId = localStorage.getItem('current_user_id');
    if (!userId) {
        alert("新規喫煙所の登録にはログインが必要です。");
        return;
    }

    isAddPinMode = !isAddPinMode;
    const btn = document.getElementById('add-pin-btn');
    if (isAddPinMode) {
        btn.style.backgroundColor = '#f39c12';
        btn.style.color = 'white';
        btn.innerHTML = '📍 マップをタップして追加 (キャンセル)';
        alert("マップ上の任意の場所をタップしてピンを追加してください。");
    } else {
        btn.style.backgroundColor = 'white';
        btn.style.color = '#333';
        btn.innerHTML = '📍 新規喫煙所をマップに打つ';
    }
}

map.on('click', async function(e) {
    if (isAddPinMode) {
        const userId = localStorage.getItem('current_user_id');
        if (!userId) return;

        const lat = e.latlng.lat;
        const lng = e.latlng.lng;

        const memo = prompt("この独自に見つけた喫煙所の名前やメモを入力してください：", "見つけた喫煙所");
        if (memo !== null && memo.trim() !== "") {
            try {
                const response = await fetch('http://localhost:3000/api/custom-places', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        userId: userId,
                        memo: memo.trim(),
                        lat: lat,
                        lon: lng
                    })
                });

                if (response.ok) {
                    alert("独自の喫煙所を登録しました！");
                    loadCustomPins();
                    toggleAddPinMode();
                } else {
                    alert("登録に失敗しました。");
                }
            } catch (error) {
                console.error('送信エラー:', error);
                alert("サーバー通信エラーが発生しました。");
            }
        }
    }
});

async function deleteCustomPin(id) {
    if (confirm("このピンを削除しますか？")) {
        try {
            const response = await fetch(`http://localhost:3000/api/custom-places/${id}`, {
                method: 'DELETE'
            });

            if (response.ok) {
                loadCustomPins();
                map.closePopup();
            } else {
                alert("削除に失敗しました。");
            }
        } catch (error) {
            console.error('削除エラー:', error);
        }
    }
}