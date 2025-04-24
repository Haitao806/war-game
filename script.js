console.log("--- script.js 开始加载 ---"); 


const CONFIG = {
    MAP: {
        CONTAINER_ID: 'map-container',
        HEX_SIZE: 30,
        ROWS: 30,  
        COLS: 18,  
        BOUNDS: {
            minLat: 37.25,  // (38.0 - 1.5 / 2)
            maxLat: 38.75,  // (38.0 + 1.5 / 2)
            minLon: 125.0, // (127.0 - 4.0 / 2)
            maxLon: 129.0  // (127.0 + 4.0 / 2)
        }
    },
    API: {
        TIMEOUT: 60000, // 保持 60 秒超时
        RETRY_COUNT: 2,
    ENDPOINTS: [
        'https://overpass-api.de/api/interpreter',
            'https://overpass.kumi.systems/api/interpreter',
            'https://maps.mail.ru/osm/tools/overpass/api/interpreter'
        ]
    },
    GAME: {
        ACTION_POINTS_PER_TURN: 3,
        FACTIONS: ['US', 'ROK', 'DPRK', 'PLA']
    }
};

// --- 游戏状态管理 ---
const GameState = {
    map: {
        grid: [],
        selectedUnit: null,
        highlightedMoves: [],
        highlightedAttacks: []
    },
    turn: {
        current: 1,
        faction: 'N/A',
        actionPoints: CONFIG.GAME.ACTION_POINTS_PER_TURN
    },
    loading: {
        isLoading: true,
        isDataLoaded: false,
        status: '',
        error: null,
        progress: {
            terrain: 0,
            units: 0,
            total: 0
        }
    },
    init: {
        isInitialized: false,
        playerFaction: null
    }
};

// --- 单位配置 ---
const UNIT_TYPES = {
    infantry: {
        name: '步兵',
        type: 'infantry',
        stats: {
            maxHealth: 10,
        attack: 5,
        defense: 3,
            movement: 3
        },
        cost: {
            resources: 50,
            actionPoints: 1
        },
        icon: '步'
    },
    tank: {
        name: '坦克',
        type: 'tank',
        stats: {
            maxHealth: 15,
        attack: 8,
        defense: 5,
            movement: 5
        },
        cost: {
            resources: 100,
            actionPoints: 2
        },
        icon: '坦'
    },
    artillery: {
        name: '火炮',
        type: 'artillery',
        stats: {
            maxHealth: 8,
        attack: 10,
        defense: 1,
        movement: 2,
            range: 2
        },
        cost: {
            resources: 80,
            actionPoints: 2
        },
        icon: '炮'
    }
};

// --- 地形配置 ---
const TERRAIN_TYPES = {
    plain: {
        name: '平原',
        movement: {
            infantry: 1,
            tank: 1,
            artillery: 1
        },
        modifiers: {
            defense: 0
            // actionPoints: 0 // 移除行动点修正
        }
    },
    forest: {
        name: '森林',
        movement: {
            infantry: 1, // 简化步兵移动
            tank: 2,
            artillery: 2
        },
        modifiers: {
            defense: 2
            // actionPoints: 1 // 移除行动点修正
        }
    },
    /* // 移除山地类型，统一视为平原
    mountain: {
        name: '山地',
        movement: {
            infantry: 2,
            tank: Infinity, 
            artillery: Infinity
        },
        modifiers: {
            defense: 3,
            actionPoints: 2
        }
    },
    */
    city: {
        name: '城市',
        movement: {
            infantry: 1,
            tank: 1,
            artillery: 1
        },
        modifiers: {
            defense: 4, // 城市提供高防御
            // actionPoints: 1 // 移除行动点修正
        }
    },
    water: { 
        name: '水域',
        movement: {
            infantry: Infinity, 
            tank: Infinity, 
            artillery: Infinity 
        },
        modifiers: {
            defense: 0
            // actionPoints: 0 // 移除行动点修正
        }
    }
};

// --- 错误处理工具 ---
const GameError = {
    throw: (message, code) => {
        const timestamp = new Date().toISOString();
        const fullMessage = `[${timestamp}] [错误 ${code}]: ${message}`;
        console.error(fullMessage); // 直接使用 console.error
        throw new Error(`${code}: ${message}`);
    },
    log: (message, type = 'info') => {
        const timestamp = new Date().toISOString();
        const fullMessage = `[${timestamp}] ${message}`;
        // 检查 console[type] 是否为函数，如果不是或不存在，则回退到 console.log
        if (typeof console[type] === 'function') {
            console[type](fullMessage);
        } else {
            console.log(`[${type.toUpperCase()}] ${fullMessage}`); // 使用 console.log 并标明原始类型
        }
    }
};

// --- 网络请求辅助函数 ---
/**
 * 带超时的 fetch 请求
 * @param {string|Request} resource 请求资源 URL 或 Request 对象
 * @param {RequestInit} options fetch 选项
 * @param {number} timeout 超时时间 (毫秒)
 * @returns {Promise<Response>}
 */
async function fetchWithTimeout(resource, options = {}, timeout = 8000) {
    GameError.log(`发起请求: ${typeof resource === 'string' ? resource : resource.url} (超时: ${timeout}ms)`);
    const controller = new AbortController();
    const id = setTimeout(() => {
        GameError.log(`请求超时: ${typeof resource === 'string' ? resource : resource.url}`, 'warn');
        controller.abort();
    }, timeout);

    try {
        const response = await fetch(resource, {
            ...options,
            signal: controller.signal
        });
        clearTimeout(id);
        GameError.log(`收到响应: ${typeof resource === 'string' ? resource : resource.url} (状态: ${response.status})`);
        return response;
    } catch (error) {
        clearTimeout(id);
        // 如果错误是因为 AbortController 中断的，我们认为是超时
        if (error.name === 'AbortError') {
            throw new Error(`Request timed out after ${timeout}ms`);
        }
        GameError.log(`请求失败: ${typeof resource === 'string' ? resource : resource.url} - ${error.message}`, 'error');
        throw error; // 重新抛出其他网络错误
    }
}

// --- 事件监听器设置 ---
document.addEventListener('DOMContentLoaded', () => {
    GameError.log("DOM加载完成，设置事件监听器...");
    
    // 检查关键元素是否存在
    const loadingScreen = document.getElementById('loading-screen');
    const factionSelection = document.getElementById('faction-selection');
    const gameInterface = document.getElementById('game-interface');
    
    if (!loadingScreen || !factionSelection || !gameInterface) {
        GameError.log("关键UI元素缺失，无法初始化", "error");
        alert("页面加载不完整，请刷新重试");
        return;
    }
    
    // 初始隐藏加载屏幕
    loadingScreen.style.display = 'none';
    GameState.loading.isLoading = false;
    GameError.log("初始加载屏幕已隐藏");

    // 显示阵营选择
    factionSelection.style.display = 'block'; // 确保阵营选择可见
    GameError.log("阵营选择界面已显示");
    
    // 设置阵营选择按钮的事件监听
    const factionButtons = factionSelection.querySelectorAll('.faction-button');
    factionButtons.forEach(button => {
        button.addEventListener('click', (e) => {
            const faction = e.currentTarget.getAttribute('data-faction');
            if (faction) {
                GameError.log(`用户点击了阵营按钮: ${faction.toUpperCase()}`);
                selectFactionAndStartGame(faction.toUpperCase());
            }
        });
    });
    GameError.log(`已为 ${factionButtons.length} 个阵营按钮添加事件监听`);

    // 其他按钮的监听器（移动到游戏初始化成功后添加）
});

/**
 * 选择阵营并开始游戏的主流程
 * @param {string} selectedFaction 玩家选择的阵营
 */
async function selectFactionAndStartGame(selectedFaction) {
    GameError.log(`开始游戏流程，选择阵营: ${selectedFaction}`);

    // 防止重复初始化
    if (GameState.init.isInitialized) {
        GameError.log('游戏已初始化，忽略此次选择', 'warn');
        return;
    }

    // 验证阵营选择
    if (!CONFIG.GAME.FACTIONS.includes(selectedFaction)) {
        GameError.log('无效的阵营选择', 'error');
        alert('选择了无效的阵营');
        return;
    }

    const factionSelector = document.getElementById('faction-selection');
    const gameInterface = document.getElementById('game-interface'); // 获取游戏界面元素

    // 更新状态并显示加载
    GameState.init.playerFaction = selectedFaction;
    GameState.turn.faction = selectedFaction;
    GameState.loading.isLoading = true;
    
    // UI 切换：隐藏阵营选择，显示加载，确保游戏界面隐藏
    if (factionSelector) factionSelector.style.display = 'none';
    if (gameInterface) gameInterface.style.display = 'none'; // 确保游戏界面先隐藏
    showLoadingScreen();
    updateLoadingStatus('正在初始化游戏...');


    try {
        // 执行核心游戏初始化 (恢复调用 processTerrainData 和 renderMap)
        await initializeGameCore();
        
        // 初始化成功
        GameState.init.isInitialized = true;
        GameState.loading.isLoading = false;
            hideLoadingScreen();
        showGameInterface(); // 显示游戏界面
        setupGameEventListeners(); // 重新启用游戏内事件监听器
        updateGameInfoUI(); // 更新回合/阵营信息
        GameError.log('游戏初始化成功并启动', 'success');

    } catch (error) {
        // 初始化失败
        GameState.loading.isLoading = false;
            hideLoadingScreen();
        GameError.log(`游戏初始化失败: ${error.message}`, 'error'); // 使用加固后的 log
        alert(`游戏加载失败: ${error.message}
请刷新页面重试。`);
        
        // 重置 UI 到初始状态：隐藏游戏界面，显示阵营选择
        if (gameInterface) gameInterface.style.display = 'none'; 
        if (factionSelector) factionSelector.style.display = 'block'; 
    }
}

/**
 * 核心游戏初始化逻辑 (恢复六边形渲染流程)
 */
async function initializeGameCore() {
    console.log("=== [2025-04-24T13:07:15.751Z] 核心游戏初始化开始 ===");
    updateLoadingText('初始化核心游戏组件...');
    
    try {
        console.log("设置地图网格...");
        await setupMapGrid(); // 初始化地图网格结构
        updateLoadingText('地图网格设置完毕。');

        console.log("获取并处理地形数据...");
        const terrainData = await fetchTerrainData(); // 获取地形数据
        if (terrainData) {
            await processTerrainData(terrainData); // 处理地形数据
            updateLoadingText('地形数据处理完毕。');
        } else {
            console.warn("未能获取地形数据，将使用默认地形。");
            await processTerrainData(null); // 确保即使没有数据，也会设置默认地形
            updateLoadingText('使用默认地形配置。');
        }

        console.log("放置初始单位...");
        placeInitialUnits(); // 放置单位
        updateLoadingText('初始单位已部署。');
        
        console.log("清除初始高亮状态..."); // <--- 新增：确保初始无高亮
        clearSelectionAndHighlights();

        console.log("首次渲染地图..."); // <--- 修改：确保在所有数据处理完后渲染
        renderMap(); 
        updateLoadingText('地图渲染完成。');

        console.log("更新游戏信息UI...");
        updateGameInfoUI();
        updateLoadingText('游戏界面准备就绪。');
        
        console.log("=== [2025-04-24T13:07:15.751Z] 核心游戏初始化完成 ===");
        GameState.init.isInitialized = true;
        
        // 不需要返回特定值，初始化成功即可
        
    } catch (error) {
        handleLoadingError(error, "核心游戏初始化");
        // 让错误向上冒泡，由调用者处理
        throw error; 
    }
}

// --- 地图网格逻辑 (保持不变，但暂时不调用) ---
function setupMapGrid() {
    return new Promise((resolve) => {
    console.log('设置地图网格...');
        GameState.map.grid = [];
        for (let r = 0; r < CONFIG.MAP.ROWS; r++) {
        const row = [];
            for (let c = 0; c < CONFIG.MAP.COLS; c++) {
            row.push({
                row: r,
                col: c,
                    terrain: 'plain',
                    unit: null,
                    owner: null
                });
            }
            GameState.map.grid.push(row);
        }
        console.log(`创建了 ${CONFIG.MAP.ROWS}x${CONFIG.MAP.COLS} 的基础网格`);
        resolve();
    });
}

// --- 单位创建与放置 (保持不变，但暂时不调用) ---
function createUnit(type, faction) {
    const baseUnit = UNIT_TYPES[type];
    
    // 深拷贝基本单位数据
    const unit = {
        type,
        faction,
        stats: { ...baseUnit.stats },
        health: baseUnit.stats.maxHealth, // 当前生命值
        hasMoved: false,
        hasAttacked: false
    };
    
    return unit;
}

/**
 * 在地图上放置所有四个阵营的初始单位 (在地形数据处理后调用)
 */
function placeInitialUnits() {
    console.log('放置所有阵营的初始单位...');

    // 定义起始区域 (示例坐标，需要根据 MAP_ROWS/COLS 调整)
    const startingAreas = {
        US: { rowRange: [CONFIG.MAP.ROWS - 4, CONFIG.MAP.ROWS - 1], colRange: [0, 6] },         // 左下
        ROK: { rowRange: [CONFIG.MAP.ROWS - 4, CONFIG.MAP.ROWS - 1], colRange: [CONFIG.MAP.COLS - 7, CONFIG.MAP.COLS - 1] }, // 右下
        DPRK: { rowRange: [0, 3], colRange: [0, 6] },                              // 左上
        PLA: { rowRange: [0, 3], colRange: [CONFIG.MAP.COLS - 7, CONFIG.MAP.COLS - 1] }         // 右上
    };

    // 为每个阵营放置单位
    CONFIG.GAME.FACTIONS.forEach(faction => {
        const area = startingAreas[faction];
        if (!area) return;

        // 增加初始单位数量
        const maxUnitsPerFaction = 8; // 每个阵营增加到8个单位
        let placedUnits = 0;

        // 预定义每个阵营的单位组成
        const unitComposition = [
            { type: 'infantry', count: 4 },  // 4个步兵
            { type: 'tank', count: 2 },      // 2个坦克
            { type: 'artillery', count: 2 }   // 2个火炮
        ];

        // 尝试次数，避免无限循环
        let attempts = 0;
        const maxAttempts = 100;

        // 按照预定义的单位组成放置单位
        for (const composition of unitComposition) {
            let placedOfType = 0;
            while (placedOfType < composition.count && attempts < maxAttempts) {
                attempts++;
                const r = Math.floor(Math.random() * (area.rowRange[1] - area.rowRange[0] + 1)) + area.rowRange[0];
                const c = Math.floor(Math.random() * (area.colRange[1] - area.colRange[0] + 1)) + area.colRange[0];

                if (GameState.map.grid[r] && GameState.map.grid[r][c] && !GameState.map.grid[r][c].unit) {
                    const terrainType = GameState.map.grid[r][c].terrain;
                    const terrainInfo = TERRAIN_TYPES[terrainType];
                    const movementCost = terrainInfo.movement.infantry;

                    if (movementCost !== Infinity) {
                        GameState.map.grid[r][c].unit = createUnit(composition.type, faction);
                        placedUnits++;
                        placedOfType++;
                        console.log(`在 [${r},${c}] 为 ${faction} 放置了 ${composition.type}`);
                    }
                }
            }
        }

        if (placedUnits < maxUnitsPerFaction) {
            console.warn(`阵营 ${faction} 未能放置足够单位 (${placedUnits}/${maxUnitsPerFaction})`);
        }
    });

    console.log('所有初始单位放置完毕。');
}

// --- 坐标转换辅助函数 (保持不变) ---
/**
 * 将经纬度坐标通过线性插值转换为网格坐标 (row, col)。
 * @param {number} lat 纬度
 * @param {number} lon 经度
 * @returns {{row: number, col: number} | null} 对应的网格坐标，如果超出边界则返回 null
 */
function latLonToGrid(lat, lon) {
    // 检查坐标是否在定义的边界框内
    if (lat < CONFIG.MAP.BOUNDS.minLat || lat > CONFIG.MAP.BOUNDS.maxLat ||
        lon < CONFIG.MAP.BOUNDS.minLon || lon > CONFIG.MAP.BOUNDS.maxLon) {
        return null; // 坐标超出范围
    }

    // 计算经纬度范围
    const latRange = CONFIG.MAP.BOUNDS.maxLat - CONFIG.MAP.BOUNDS.minLat;
    const lonRange = CONFIG.MAP.BOUNDS.maxLon - CONFIG.MAP.BOUNDS.minLon;

    // 将经纬度标准化到 0-1 的范围
    // 注意纬度映射：北边 (maxLat) 对应第 0 行，南边 (minLat) 对应最后一行
    const normalizedLat = (CONFIG.MAP.BOUNDS.maxLat - lat) / latRange;
    const normalizedLon = (lon - CONFIG.MAP.BOUNDS.minLon) / lonRange;

    // 将标准化后的值映射到网格行列号
    let row = Math.floor(normalizedLat * CONFIG.MAP.ROWS);
    let col = Math.floor(normalizedLon * CONFIG.MAP.COLS);

    // 确保行列号在有效范围内 (钳位)
    row = Math.max(0, Math.min(CONFIG.MAP.ROWS - 1, row));
    col = Math.max(0, Math.min(CONFIG.MAP.COLS - 1, col));

    return { row, col };
}

/**
 * 将网格坐标 (row, col) 通过线性插值反向转换为经纬度坐标。
 * @param {number} row 行号
 * @param {number} col 列号
 * @returns {{lat: number, lon: number}} 近似的经纬度坐标 (格子中心点)
 */
function gridToLatLon(row, col) {
    const latRange = CONFIG.MAP.BOUNDS.maxLat - CONFIG.MAP.BOUNDS.minLat;
    const lonRange = CONFIG.MAP.BOUNDS.maxLon - CONFIG.MAP.BOUNDS.minLon;

    // 计算格子中心在 0-1 标准化区间的比例
    // 注意纬度反向：第 0 行对应 maxLat
    const normalizedLat = (row + 0.5) / CONFIG.MAP.ROWS;
    const normalizedLon = (col + 0.5) / CONFIG.MAP.COLS;

    const lat = CONFIG.MAP.BOUNDS.maxLat - normalizedLat * latRange;
    const lon = CONFIG.MAP.BOUNDS.minLon + normalizedLon * lonRange;

    return { lat, lon };
}

// --- 地形数据获取 (保持不变，返回数据或 false) ---
async function fetchTerrainData() {
    updateLoadingStatus('Loading');
    let endpointIndex = 0;
    const bbox = `${CONFIG.MAP.BOUNDS.minLat},${CONFIG.MAP.BOUNDS.minLon},${CONFIG.MAP.BOUNDS.maxLat},${CONFIG.MAP.BOUNDS.maxLon}`;
    const query = `
[out:json][timeout:${CONFIG.API.TIMEOUT / 1000}];
(
  // Keep existing land features
  way["natural"="wood"](${bbox});
  relation["natural"="wood"](${bbox});
  way["landuse"="forest"](${bbox});
  relation["landuse"="forest"](${bbox});
  node["natural"="peak"](${bbox});
  way["natural"="ridge"](${bbox});
  relation["natural"="ridge"](${bbox});
  node["place"~"^(city|town)$"](${bbox});
  way["place"~"^(city|town)$"](${bbox});
  relation["place"~"^(city|town)$"](${bbox});
  way["landuse"="residential"](${bbox});
  way["landuse"="commercial"](${bbox});
  way["landuse"="industrial"](${bbox});
  relation["landuse"="residential"](${bbox});
  relation["landuse"="commercial"](${bbox});
  relation["landuse"="industrial"](${bbox});
  
  // Add water features
  way["natural"="water"](${bbox});
  relation["natural"="water"](${bbox});
);
out geom;
`;

    GameError.log(`准备发送 Overpass 查询 (范围: ${bbox})`);

    for (let endpoint of CONFIG.API.ENDPOINTS) {
        endpointIndex++;
        try {
            GameError.log(`向 API 端点 ${endpointIndex}/${CONFIG.API.ENDPOINTS.length} 发送请求: ${endpoint}`);
            const response = await fetchWithTimeout(endpoint, {
                    method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: `data=${encodeURIComponent(query)}`
            }, CONFIG.API.TIMEOUT);

            if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
            const responseText = await response.text(); 
            if (!responseText) throw new Error('Empty response from API');
            
            let data;
            try { data = JSON.parse(responseText); } catch (e) { throw new Error('Failed to parse API response as JSON'); }
            if (data && data.remark && (data.remark.includes('error') || data.remark.includes('timeout'))) throw new Error(`Overpass API Error: ${data.remark}`);
            if (!data.elements || !Array.isArray(data.elements)) throw new Error('Invalid data structure in API response');
            //if (data.elements.length === 0) throw new Error('No geographic elements found'); // 允许空结果

            GameError.log(`成功从 ${endpoint} 获取地形数据 (${data.elements.length} 个要素)`);
            GameState.loading.isDataLoaded = true;
            return data; // 成功时返回数据
        } catch (error) {
            handleLoadingError(error, `地形数据获取 (${endpoint})`);
            if (endpointIndex < CONFIG.API.ENDPOINTS.length) GameError.log('尝试下一个 API 端点...');
            continue;
        }
    }

    GameError.log('所有 API 端点均获取地形数据失败。', 'warn');
    return false; // 所有尝试失败，返回 false
}

// --- 地形数据处理 (恢复调用) ---
async function processTerrainData(data) {
    console.log("=== 开始处理地形数据 (简化版) ===");
    updateLoadingText('正在处理地形数据 (简化版)...');
    
    if (!GameState.map.grid || GameState.map.grid.length === 0) {
        GameError.log("地图网格未初始化，正在重新初始化...", 'warn');
        await setupMapGrid(); 
    }
    
    console.log("设置默认地形（平原）...");
    for (let r = 0; r < CONFIG.MAP.ROWS; r++) {
        for (let c = 0; c < CONFIG.MAP.COLS; c++) {
            if (GameState.map.grid[r]?.[c]) {
                    GameState.map.grid[r][c].terrain = 'plain';
            }
        }
    }

    if (data && data.elements && data.elements.length > 0) {
        console.log(`开始处理 ${data.elements.length} 个地形元素 (简化流程)...`);
        
        // 简化地形优先级，水最低，城市最高，森林次之
        const terrainPriority = { 'city': 3, 'forest': 2, 'plain': 1, 'water': 0 }; 
        let terrainCounts = { city: 0, forest: 0, plain: 0, water: 0 }; // 移除 mountain 计数

        const processElement = async (element, index) => {
            if (index % 5000 === 0) { // 减少日志频率
                console.log(`已处理 ${index}/${data.elements.length} 个元素...`);
            }

            let currentTerrainType = 'plain'; 
            const tags = element.tags || {};

            // 简化地形类型判断
            if (tags.natural === 'water') {
                currentTerrainType = 'water';
            } else if (tags.natural === 'wood' || tags.landuse === 'forest') {
                currentTerrainType = 'forest';
            } else if (tags.place === 'city' || tags.place === 'town' || 
                      tags.landuse === 'residential' || tags.landuse === 'commercial' || 
                      tags.landuse === 'industrial') {
                currentTerrainType = 'city';
            }
            // 所有其他类型 (包括山地) 均视为 'plain'

            // 只统计明确识别的地形
            if (currentTerrainType !== 'plain') {
            terrainCounts[currentTerrainType]++;
            }

            try {
                 // 只处理节点 (Node) 以简化逻辑，忽略 Way 和 Relation 的复杂边界处理
                 if (element.type === 'node' && typeof element.lat === 'number' && typeof element.lon === 'number') {
                    const gridCoords = latLonToGrid(element.lat, element.lon);
                    if (gridCoords) {
                        const { row, col } = gridCoords;
                        if (GameState.map.grid[row]?.[col]) {
                            // 使用简化后的优先级判断覆盖
                            if (terrainPriority[currentTerrainType] > terrainPriority[GameState.map.grid[row][col].terrain]) {
                            GameState.map.grid[row][col].terrain = currentTerrainType;
                        }
                    }
                } 
                 } 
                 // Way 和 Relation 不再处理，避免边界框带来的问题
             } catch (error) {
                 GameError.log(`处理元素 ${element.id} 时发生错误: ${error.message}`, 'error');
             }
        };
        
        // 保持分批处理
        const batchSize = 5000; // 增大批次，减少日志
        for(let i = 0; i < data.elements.length; i += batchSize) {
             const batch = data.elements.slice(i, i + batchSize);
             updateLoadingText(`处理地形数据批次 ${Math.ceil((i+1)/batchSize)}...`);
             // 注意：不再使用 Promise.all，改为串行处理每个元素，减少潜在的并发问题
             for (let j = 0; j < batch.length; j++) {
                 await processElement(batch[j], i + j);
             }
             // 稍微延迟一下，避免完全卡死浏览器
             await new Promise(r => setTimeout(r, 10)); 
        }

        console.log("地形处理统计 (简化版):");
        console.log(`- 城市: ${terrainCounts.city}`);
        console.log(`- 森林: ${terrainCounts.forest}`);
        console.log(`- 水域: ${terrainCounts.water}`);
    } else {
        console.log("使用默认地形配置（无有效地形数据）");
        updateLoadingText('使用默认地形配置...');
    }
    
    console.log("=== 地形数据处理完成 (简化版) ===");
}

// --- 地图渲染 (恢复调用) ---
function renderMap() {
    const mapContainer = document.getElementById(CONFIG.MAP.CONTAINER_ID);
    if (!mapContainer) {
        console.error('找不到地图容器元素！');
        return;
    }
    mapContainer.innerHTML = '';

    let renderedHexes = 0;

    for (let r = 0; r < CONFIG.MAP.ROWS; r++) {
        if (!GameState.map.grid[r]) continue; 
        for (let c = 0; c < CONFIG.MAP.COLS; c++) {
            if (!GameState.map.grid[r][c]) continue; 
            
            try {
                const hex = document.createElement('div');
                hex.className = 'hex';
                hex.setAttribute('data-row', r);
                hex.setAttribute('data-col', c);
                const {x, y} = calculateHexPosition(r, c);
                hex.style.left = x + 'px';
                hex.style.top = y + 'px';
                hex.style.width = (CONFIG.MAP.HEX_SIZE * 2) + 'px';
                hex.style.height = (CONFIG.MAP.HEX_SIZE * Math.sqrt(3)) + 'px';

                const terrainType = GameState.map.grid[r][c].terrain;
                hex.classList.add(`terrain-${terrainType}`);

                if (GameState.map.highlightedMoves.some(coord => coord.row === r && coord.col === c)) {
                    hex.classList.add('reachable');
                }
                if (GameState.map.highlightedAttacks.some(coord => coord.row === r && coord.col === c)) {
                    hex.classList.add('attackable');
                }

                const owner = GameState.map.grid[r][c].owner;
                if (terrainType === 'city' && owner) {
                    const flag = document.createElement('span');
                    flag.className = `flag flag-${owner.toLowerCase()}`;
                    flag.textContent = '★';
                    flag.title = `${owner} 占领`;
                    hex.appendChild(flag);
                }

                const unit = GameState.map.grid[r][c].unit;
                if (unit) {
                    const unitDiv = document.createElement('div');
                    unitDiv.className = `unit unit-${unit.faction.toLowerCase()}`;
                    const unitImg = document.createElement('img');
                    const imgPath = `images/${unit.faction.toLowerCase()}_${unit.type}.png`;
                    unitImg.src = imgPath;
                    unitImg.alt = `${unit.faction} ${UNIT_TYPES[unit.type].name}`;
                    unitImg.title = `${unit.faction} ${UNIT_TYPES[unit.type].name} (HP: ${unit.health}/${unit.stats.maxHealth})`;
                    unitImg.onerror = () => { 
                        console.warn(`Image loading failed: ${imgPath}`);
                        unitDiv.style.backgroundColor = getComputedStyle(document.documentElement).getPropertyValue(`--faction-${unit.faction.toLowerCase()}-color`) || '#888'; 
                        unitDiv.textContent = UNIT_TYPES[unit.type].icon || '?';
                        unitImg.style.display = 'none';
                    };
                    unitDiv.appendChild(unitImg);
                    hex.appendChild(unitDiv);
                if (GameState.map.selectedUnit && GameState.map.selectedUnit.row === r && GameState.map.selectedUnit.col === c) {
                    hex.classList.add('selected');
                    }
                }

                hex.addEventListener('click', () => handleHexClick(r, c));
                mapContainer.appendChild(hex);
                renderedHexes++;

            } catch (e) {
                console.error(`Error rendering hex (${r}, ${c}):`, e);
            }
        }
    }
}

// --- 用户界面更新 (保持不变) ---
function updateGameInfoUI() {
    document.getElementById('current-faction').textContent = `${GameState.turn.faction} (${GameState.turn.faction === GameState.init.playerFaction ? 'Player' : 'AI'})`;
    document.getElementById('current-turn').textContent = GameState.turn.current;
    // 更新行动点数显示
    const actionPointsDisplay = document.getElementById('action-points');
    if (actionPointsDisplay) {
        actionPointsDisplay.textContent = `Action Points: ${GameState.turn.actionPoints}/${CONFIG.GAME.ACTION_POINTS_PER_TURN}`;
    } else {
        // 如果元素不存在，创建一个
        const gameInfo = document.querySelector('.game-info');
        if (gameInfo) {
            const apDiv = document.createElement('div');
            apDiv.id = 'action-points';
            apDiv.textContent = `Action Points: ${GameState.turn.actionPoints}/${CONFIG.GAME.ACTION_POINTS_PER_TURN}`;
            gameInfo.appendChild(apDiv);
        }
    }
}

function updateUnitInfoUI(unitData) {
    const infoElement = document.getElementById('selected-unit-info');
    const actionButtons = document.querySelectorAll('#action-buttons-corner .action-button'); // 更精确的选择器
    const selectedUnitIcon = document.getElementById('selected-unit-icon'); // 获取图标元素

    // 清除旧的按钮提示信息 (如果存在)
    document.querySelectorAll('#action-buttons-corner .action-message').forEach(el => el.remove());

    if (unitData) {
        // 更新侧边栏信息
        infoElement.innerHTML = `
            HP: ${unitData.health}/${unitData.stats.maxHealth} | ATK: ${unitData.stats.attack} | DEF: ${unitData.stats.defense}<br>
            Movement: ${unitData.stats.movement} ${unitData.stats.range ? `| Range: ${unitData.stats.range}` : ''}<br>
            Status: ${unitData.hasMoved ? 'Moved' : 'Can move'} | ${unitData.hasAttacked ? 'Attacked' : 'Can attack'}
        `; // 简化信息显示

        // 更新选中单位图标
        if (selectedUnitIcon) {
            const unitImagePath = `images/${unitData.faction.toLowerCase()}_${unitData.type}.png`;
            selectedUnitIcon.src = unitImagePath;
            selectedUnitIcon.alt = `${unitData.faction} ${UNIT_TYPES[unitData.type].name}`;
            selectedUnitIcon.style.display = 'inline-block'; // 显示图标 (inline-block)
        }

        // 根据单位状态和当前行动点数来启用/禁用按钮
        actionButtons.forEach(button => {
            button.disabled = true;
            const buttonType = button.id;
            let disableReason = '';
            const baseActionCost = UNIT_TYPES[unitData.type]?.cost?.actionPoints || 1;

            // 移动按钮
            if (buttonType === 'move-button') {
                if (unitData.hasMoved) {
                    disableReason = 'Moved';
                } else if (GameState.turn.actionPoints < baseActionCost) {
                    disableReason = `Not enough points (${GameState.turn.actionPoints}/${baseActionCost})`;
                } else if (unitData.faction !== GameState.turn.faction || GameState.turn.faction !== GameState.init.playerFaction) {
                    disableReason = 'Cannot operate';
                } else {
                    button.disabled = false;
                }
            }
            // 攻击按钮
            else if (buttonType === 'attack-button') {
                if (unitData.hasAttacked) {
                    disableReason = 'Attacked';
                } else if (GameState.turn.actionPoints < baseActionCost) {
                    disableReason = `Not enough points (${GameState.turn.actionPoints}/${baseActionCost})`;
                } else if (unitData.faction !== GameState.turn.faction || GameState.turn.faction !== GameState.init.playerFaction) {
                    disableReason = 'Cannot operate';
                } else {
                    const attackRange = calculateAttackRange(GameState.map.selectedUnit.row, GameState.map.selectedUnit.col);
                    if (attackRange.length === 0) {
                        disableReason = 'No target';
                    } else {
                        button.disabled = false;
                    }
                }
            }
            // 占领按钮
            else if (buttonType === 'capture-button') {
                const captureActionCost = 2; // 占领需要2点行动点数
                const hex = GameState.map.grid[GameState.map.selectedUnit.row][GameState.map.selectedUnit.col];
                const terrainType = hex.terrain;
                
                if (terrainType !== 'city') {
                    disableReason = 'Can only capture city terrain';
                } else if (hex.owner === unitData.faction) {
                    disableReason = 'This city is already occupied by your faction';
                } else if (unitData.hasMoved || unitData.hasAttacked) {
                    disableReason = 'Unit has already moved or attacked this turn, cannot capture';
                } else if (GameState.turn.actionPoints < captureActionCost) {
                    disableReason = `Need ${captureActionCost} action points (remaining ${GameState.turn.actionPoints} points)`;
                } else if (unitData.faction !== GameState.turn.faction) {
                    disableReason = 'Can only operate units of the current turn faction';
                } else if (GameState.turn.faction !== GameState.init.playerFaction) {
                    disableReason = 'Current turn is not player\'s turn';
                } else {
                    button.disabled = false; // 满足所有条件，启用按钮
                }
            }
            
            // 如果按钮被禁用且有原因，显示提示信息
            if (button.disabled && disableReason) {
                const messageElement = document.createElement('div');
                messageElement.className = 'action-message';
                messageElement.textContent = disableReason;
                messageElement.style.color = '#e74c3c';
                messageElement.style.fontSize = '0.8em';
                messageElement.style.marginTop = '4px';
                button.parentNode.appendChild(messageElement);
            }
        });
    } else {
        infoElement.textContent = '未选择单位';
        actionButtons.forEach(button => button.disabled = true); // 没有选中单位时禁用所有按钮
    }
}

// --- 事件处理 (恢复 handleHexClick 的游戏逻辑) ---
function handleHexClick(row, col) {
    // ... (handleHexClick 的完整逻辑恢复) ...
    if (!GameState.map.grid[row] || !GameState.map.grid[row][col]) return;
    const clickedHexData = GameState.map.grid[row][col];
    const clickedUnit = clickedHexData.unit;

    // 移动逻辑部分
    if (GameState.map.selectedUnit && GameState.map.highlightedMoves.some(coord => coord.row === row && coord.col === col) && !clickedUnit) {
        const unitToMove = GameState.map.grid[GameState.map.selectedUnit.row][GameState.map.selectedUnit.col].unit;
        if (unitToMove && !unitToMove.hasMoved && unitToMove.faction === GameState.turn.faction && GameState.turn.faction === GameState.init.playerFaction) {
            const baseActionCost = UNIT_TYPES[unitToMove.type].cost.actionPoints;
            const terrainActionCost = TERRAIN_TYPES[clickedHexData.terrain].modifiers.actionPoints;
            const totalActionCost = baseActionCost + terrainActionCost;

            if (GameState.turn.actionPoints < totalActionCost) {
                showTemporaryMessage(`行动点数不足！需要 ${totalActionCost} 点（基础 ${baseActionCost} + 地形 ${terrainActionCost}），剩余 ${GameState.turn.actionPoints} 点`);
                updateUnitInfoUI(unitToMove);
                return;
            }

            console.log(`移动单位 ${unitToMove.type} 从 [${GameState.map.selectedUnit.row}, ${GameState.map.selectedUnit.col}] 到 [${row}, ${col}]，消耗 ${totalActionCost} 点行动点数`);
            GameState.turn.actionPoints -= totalActionCost;
            
            GameState.map.grid[row][col].unit = unitToMove;
            GameState.map.grid[GameState.map.selectedUnit.row][GameState.map.selectedUnit.col].unit = null;
            unitToMove.hasMoved = true;
            
            clearSelectionAndHighlights();
            GameState.map.selectedUnit = { row, col };
            updateUnitInfoUI(unitToMove);
            GameState.map.highlightedMoves = [];
            if (!unitToMove.hasAttacked) {
                GameState.map.highlightedAttacks = calculateAttackRange(row, col);
            }
            
            console.log("Before renderMap (selection):", GameState.map.highlightedMoves, GameState.map.highlightedAttacks); // Log before render
            renderMap();
            const hexElement = document.querySelector(`.hex[data-row='${row}'][data-col='${col}']`);
            if(hexElement) hexElement.classList.add('selected');
            return;
        }
    }

    // 攻击逻辑部分
    if (GameState.map.selectedUnit && clickedUnit && clickedUnit.faction !== GameState.turn.faction && GameState.turn.faction === GameState.init.playerFaction) {
        const attackerUnit = GameState.map.grid[GameState.map.selectedUnit.row][GameState.map.selectedUnit.col].unit;
        const targetCoords = { row, col };

        if (attackerUnit && !attackerUnit.hasAttacked) {
            const attackRange = calculateAttackRange(GameState.map.selectedUnit.row, GameState.map.selectedUnit.col);
            if (attackRange.some(coord => coord.row === targetCoords.row && coord.col === targetCoords.col)) {
                const attackCost = UNIT_TYPES[attackerUnit.type].cost.actionPoints;
                if (GameState.turn.actionPoints < attackCost) {
                    showTemporaryMessage(`行动点数不足！需要 ${attackCost} 点，剩余 ${GameState.turn.actionPoints} 点`);
                    updateUnitInfoUI(attackerUnit);
                    return;
                }
                GameState.turn.actionPoints -= attackCost;
                updateGameInfoUI();
                console.log(`执行攻击: ${attackerUnit.type} [${GameState.map.selectedUnit.row}, ${GameState.map.selectedUnit.col}] -> ${clickedUnit.type} [${row}, ${col}]`);
                performAttack(GameState.map.selectedUnit, targetCoords);
                return;
            } else {
                showTemporaryMessage('目标不在攻击范围内');
            }
        } else if (attackerUnit && attackerUnit.hasAttacked) {
            showTemporaryMessage('此单位本回合已攻击过');
        }
    }

    // 清理之前的选择和高亮
    clearSelectionAndHighlights();

    // 选择逻辑部分
    if (clickedUnit) {
        GameState.map.selectedUnit = { row, col };
        const selectedUnit = clickedUnit;
        console.log('选中单位:', selectedUnit);
        updateUnitInfoUI(selectedUnit);

        if (selectedUnit.faction === GameState.turn.faction) {
            if (!selectedUnit.hasMoved) GameState.map.highlightedMoves = calculateMovementRange(row, col);
            else GameState.map.highlightedMoves = [];
            if (!selectedUnit.hasAttacked) GameState.map.highlightedAttacks = calculateAttackRange(row, col);
            else GameState.map.highlightedAttacks = [];
        }
        console.log("Before renderMap (selection):", GameState.map.highlightedMoves, GameState.map.highlightedAttacks); // Log before render
        renderMap(); // <--- renderMap 会根据 GameState.map.selectedUnit 添加 selected 类
        // const hexElement = document.querySelector(`.hex[data-row='${row}'][data-col='${col}']`); // <--- 移除
        // if(hexElement) hexElement.classList.add('selected'); // <--- 移除这行冗余代码
    } else {
        updateUnitInfoUI(null);
        console.log("Before renderMap (deselection):", GameState.map.highlightedMoves, GameState.map.highlightedAttacks); // Log before render
        renderMap();
    }
}

// --- 临时消息 (保持不变) ---
function showTemporaryMessage(message, duration = 3000) {
    // 创建消息元素
    const messageElement = document.createElement('div');
    messageElement.className = 'temporary-message';
    messageElement.textContent = message;
    messageElement.style.position = 'fixed';
    messageElement.style.top = '20px';
    messageElement.style.left = '50%';
    messageElement.style.transform = 'translateX(-50%)';
    messageElement.style.backgroundColor = 'rgba(231, 76, 60, 0.8)';
    messageElement.style.color = 'white';
    messageElement.style.padding = '10px 20px';
    messageElement.style.borderRadius = '5px';
    messageElement.style.boxShadow = '0 2px 10px rgba(0,0,0,0.2)';
    messageElement.style.zIndex = '9999';
    messageElement.style.fontWeight = 'bold';
    messageElement.style.textAlign = 'center';
    messageElement.style.minWidth = '200px';
    
    // 添加到body
    document.body.appendChild(messageElement);
    
    // 淡入效果
    messageElement.style.opacity = '0';
    messageElement.style.transition = 'opacity 0.3s ease-in-out';
    setTimeout(() => messageElement.style.opacity = '1', 10);
    
    // 自动删除
    setTimeout(() => {
        messageElement.style.opacity = '0';
        setTimeout(() => {
            if (messageElement.parentNode) {
                messageElement.parentNode.removeChild(messageElement);
            }
        }, 300);
    }, duration);
}

// --- 清理函数 (保持不变) ---
function clearSelectionAndHighlights() {
    GameState.map.selectedUnit = null;
    GameState.map.highlightedMoves = [];
    GameState.map.highlightedAttacks = [];
    console.log("Cleared highlights:", GameState.map.highlightedMoves, GameState.map.highlightedAttacks); // 添加日志
    // document.querySelectorAll('.hex.selected').forEach(el => el.classList.remove('selected')); // 移除这行，让 renderMap 处理 selected
    // 注意：高亮移除会在 renderMap 中自动处理
}

// --- 移动/攻击范围计算 (保持不变，但暂时不调用) ---
/**
 * 计算从起点开始的可移动范围
 * @param {number} startRow 起始行
 * @param {number} startCol 起始列
 * @returns {Array<{row: number, col: number}>} 可到达的格子坐标数组
 */
function calculateMovementRange(startRow, startCol) {
    if (!GameState.map.grid[startRow] || !GameState.map.grid[startRow][startCol] || !GameState.map.grid[startRow][startCol].unit) {
        return [];
    }
    const unit = GameState.map.grid[startRow][startCol].unit;
    const maxMovementPoints = unit.stats.movement;
    const unitType = unit.type;

    let reachable = []; // 最终可达格子列表 (不含起点)
    let visited = new Set(); // 存储访问过的格子坐标 'row,col'
    let queue = [{ row: startRow, col: startCol, cost: 0 }]; // 待处理队列 {坐标, 已消耗移动力}

    visited.add(`${startRow},${startCol}`);

    while (queue.length > 0) {
        const current = queue.shift();

        // 获取当前格子的邻居
        const neighbors = getHexNeighbors(current.row, current.col);

        for (const neighbor of neighbors) {
            const neighborKey = `${neighbor.row},${neighbor.col}`;
            if (!visited.has(neighborKey)) {
                const neighborHex = GameState.map.grid[neighbor.row] ? GameState.map.grid[neighbor.row][neighbor.col] : null;
                if (neighborHex) {
                    const terrainType = neighborHex.terrain;
                    const terrainInfo = TERRAIN_TYPES[terrainType];
                    const moveCost = terrainInfo.movement.infantry;

                    // 检查是否可进入 (成本不是 Infinity) 且没有被其他单位占据
                    if (moveCost !== Infinity && !neighborHex.unit) {
                        const totalCost = current.cost + moveCost;
                        if (totalCost <= maxMovementPoints) {
                            visited.add(neighborKey);
                            queue.push({ ...neighbor, cost: totalCost });
                            reachable.push(neighbor); // 加入可达列表
                        }
                    }
                     // 可以扩展规则允许进入友方单位格子，但不能停留
                }
            }
        }
    }
    return reachable;
}

/**
 * 获取指定六边形的所有有效邻居坐标
 * @param {number} r 行号
 * @param {number} c 列号
 * @returns {Array<{row: number, col: number}>} 邻居坐标数组
 */
function getHexNeighbors(r, c) {
    // 定义 pointy-top 六边形的邻居相对坐标 (偏移坐标系)
    // [rowOffset, colOffset]
    const evenRowNeighbors = [
        [-1, 0], [-1, +1], [0, +1],
        [+1, +1], [+1, 0], [0, -1]
    ];
    const oddRowNeighbors = [
        [-1, -1], [-1, 0], [0, +1],
        [+1, 0], [+1, -1], [0, -1]
    ];

    const neighborsOffsets = (r % 2 === 0) ? evenRowNeighbors : oddRowNeighbors;
    const neighbors = [];

    for (const [dr, dc] of neighborsOffsets) {
        const nr = r + dr;
        const nc = c + dc;
        // 检查邻居是否在地图边界内
        if (nr >= 0 && nr < CONFIG.MAP.ROWS && nc >= 0 && nc < CONFIG.MAP.COLS) {
            neighbors.push({ row: nr, col: nc });
        }
    }
    return neighbors;
}

// --- 攻击范围计算 (保持不变，但暂时不调用) ---
/**
 * 计算单位的攻击范围
 * @param {number} startRow 起始行
 * @param {number} startCol 起始列
 * @returns {Array<{row: number, col: number}>} 可攻击的格子坐标数组
 */
function calculateAttackRange(startRow, startCol) {
    if (!GameState.map.grid[startRow] || !GameState.map.grid[startRow][startCol] || !GameState.map.grid[startRow][startCol].unit) {
        return [];
    }
    const unit = GameState.map.grid[startRow][startCol].unit;
    const range = UNIT_TYPES[unit.type].stats.range || 1; // 默认射程为 1

    let attackable = [];
    let visited = new Set();
    let queue = [{ row: startRow, col: startCol, distance: 0 }];
    visited.add(`${startRow},${startCol}`);

    // 使用类似 BFS 的方法查找指定距离内的格子
    while(queue.length > 0) {
        const current = queue.shift();

        // 如果当前距离在射程内 (但不包括自身)，则加入可攻击列表
        // 注意：这里我们查找的是所有在范围内的格子，后续再判断格子上是否有敌人
        if (current.distance > 0 && current.distance <= range) {
             attackable.push({ row: current.row, col: current.col });
        }

        // 如果当前距离小于最大射程，继续探索邻居
        if (current.distance < range) {
            const neighbors = getHexNeighbors(current.row, current.col);
            for (const neighbor of neighbors) {
                const neighborKey = `${neighbor.row},${neighbor.col}`;
                if (!visited.has(neighborKey)) {
                    visited.add(neighborKey);
                    queue.push({ ...neighbor, distance: current.distance + 1 });
                }
            }
        }
    }

    // 过滤掉没有敌方单位的格子 (可选，也可以在点击时判断)
    attackable = attackable.filter(coord => {
        const targetHex = GameState.map.grid[coord.row]?.[coord.col];
        return targetHex?.unit && targetHex.unit.faction !== unit.faction;
    });

    return attackable;
}

// --- 攻击执行 (保持不变，但暂时不调用) ---
/**
 * 执行攻击动作
 * @param {{row: number, col: number}} attackerCoords 攻击方坐标
 * @param {{row: number, col: number}} defenderCoords 防守方坐标
 */
function performAttack(attackerCoords, defenderCoords) {
    const attackerHex = GameState.map.grid[attackerCoords.row]?.[attackerCoords.col];
    const defenderHex = GameState.map.grid[defenderCoords.row]?.[defenderCoords.col];

    if (!attackerHex?.unit || !defenderHex?.unit) {
        console.error('攻击或防御单位无效');
        return;
    }

    const attackerUnit = attackerHex.unit;
    const defenderUnit = defenderHex.unit;
    const defenderTerrain = defenderHex.terrain;

    // 使用新的伤害计算函数
    const damage = calculateEstimatedDamage(attackerUnit, defenderUnit, defenderTerrain);
    
    // 增加随机性因素（伤害上下浮动10%）
    const randomFactor = 0.9 + Math.random() * 0.2; // 0.9-1.1
    const finalDamage = Math.max(1, Math.floor(damage * randomFactor));
    
    // 记录攻击前的生命值，用于计算伤害百分比
    const beforeHp = defenderUnit.health;
    
    // 输出详细战斗信息
    let battleLog = `${attackerUnit.faction} ${attackerUnit.type} 从 [${attackerCoords.row}, ${attackerCoords.col}] 攻击 ${defenderUnit.faction} ${defenderUnit.type} 于 [${defenderCoords.row}, ${defenderCoords.col}]`;
    
    // 地形影响
    const terrainEffect = {
        'plain': '平原(无防御加成)',
        'forest': '森林(+2防御)',
        'mountain': '山地(+3防御)',
        'city': '城市(+2防御)',
        'water': '水域(无防御加成)'
    }[defenderTerrain] || '未知地形';
    
    battleLog += `\n防御单位位于${terrainEffect}`;
    
    // 伤害计算详细信息
    let attackPower = attackerUnit.stats.attack;
    const healthModifier = 0.5 + (attackerUnit.health / attackerUnit.stats.maxHealth) * 0.5;
    attackPower = Math.floor(attackPower * healthModifier);
    
    battleLog += `\n攻击力: ${attackerUnit.stats.attack}`;
    if (healthModifier < 1) {
        battleLog += ` (因健康度降低到${Math.floor(healthModifier * 100)}%)`;
    }
    
    // 单位相克关系
    let typeAdvantage = 1;
    if (attackerUnit.type === 'artillery' && defenderUnit.type === 'infantry') {
        typeAdvantage = 1.5;
        battleLog += `\n火炮对步兵有效(+50%伤害)`;
    } else if (attackerUnit.type === 'tank' && defenderUnit.type === 'artillery') {
        typeAdvantage = 1.3;
        battleLog += `\n坦克对火炮有效(+30%伤害)`;
    } else if (attackerUnit.type === 'infantry' && defenderUnit.type === 'tank') {
        typeAdvantage = 1.2;
        battleLog += `\n步兵对坦克有效(+20%伤害)`;
    }

    // 应用伤害
    defenderUnit.health -= finalDamage;
    const hpPercentage = Math.floor((finalDamage / beforeHp) * 100);
    
    battleLog += `\n造成 ${finalDamage} 点伤害(${hpPercentage}%)`;

    // 检查防御方是否被击毁
    if (defenderUnit.health <= 0) {
        battleLog += `\n${defenderUnit.faction} ${defenderUnit.type} 被击毁!`;
        defenderHex.unit = null; // 从地图移除单位
    } else {
        battleLog += `\n${defenderUnit.faction} ${defenderUnit.type} 剩余生命值: ${defenderUnit.health}/${defenderUnit.stats.maxHealth}`;
    }
    
    console.log(battleLog);
    
    // 如果在开发者模式中，记录战斗信息
    if (typeof logBattleInfo === 'function') {
        const battleSummary = `${attackerUnit.faction} ${attackerUnit.type} 攻击 ${defenderUnit.faction} ${defenderUnit.type}，造成 ${finalDamage} 点伤害${defenderUnit.health <= 0 ? '，将其击毁！' : ''}`;
        logBattleInfo(battleSummary, 'attack');
    }

    // 更新攻击方状态
    attackerUnit.hasAttacked = true;
    // 规则：攻击后本回合不能再移动 (如果之前可以移动)
    attackerUnit.hasMoved = true;

    // 清理选择和高亮，并重绘
    clearSelectionAndHighlights();
    updateUnitInfoUI(null); // 清除侧边栏信息，因为行动已结束
    renderMap();
    
    // 显示战斗结果通知
    let resultMessage = '';
    if (defenderUnit.health <= 0) {
        resultMessage = `${attackerUnit.faction} ${attackerUnit.type} 击毁了 ${defenderUnit.faction} ${defenderUnit.type}！`;
    } else {
        resultMessage = `${attackerUnit.faction} ${attackerUnit.type} 对 ${defenderUnit.faction} ${defenderUnit.type} 造成 ${finalDamage} 点伤害`;
    }
    showTemporaryMessage(resultMessage, 3000);
}

// --- AI 相关 (保持不变，但暂时不调用) ---
/**
 * 计算两个六边形格子之间的距离 (单位：步数)
 * 需要将偏移坐标转换为轴坐标或其他适合计算距离的坐标系
 * 这里使用一个简化的曼哈顿距离变种，适用于六边形
 * @param {{row: number, col: number}} coords1
 * @param {{row: number, col: number}} coords2
 * @returns {number} 距离
 */
function calculateHexDistance(coords1, coords2) {
    // 简化距离计算：将偏移坐标近似转换为立方体坐标来计算距离
    // see https://www.redblobgames.com/grids/hexagons/#distances
    // Convert offset to cube coordinates
    const r1 = coords1.col;
    const q1 = coords1.row - (coords1.col + (coords1.col & 1)) / 2;
    const s1 = -q1 - r1;

    const r2 = coords2.col;
    const q2 = coords2.row - (coords2.col + (coords2.col & 1)) / 2;
    const s2 = -q2 - r2;

    // Calculate Manhattan distance on cube coordinates
    const dist = (Math.abs(q1 - q2) + Math.abs(r1 - r2) + Math.abs(s1 - s2)) / 2;
    return dist;
}

/**
 * 查找属于特定阵营的所有单位及其坐标
 * @param {string} faction
 * @returns {Array<{unit: object, coords: {row: number, col: number}}>}
 */
function findUnitsOfFaction(faction) {
    const units = [];
    for (let r = 0; r < CONFIG.MAP.ROWS; r++) {
        for (let c = 0; c < CONFIG.MAP.COLS; c++) {
            const unit = GameState.map.grid[r]?.[c]?.unit;
            if (unit && unit.faction === faction) {
                units.push({ unit: unit, coords: { row: r, col: c } });
            }
        }
    }
    return units;
}

/**
 * 找到离指定单位最近的敌方单位
 * @param {{row: number, col: number}} unitCoords AI 单位坐标
 * @param {string} aiFaction AI 阵营
 * @returns {{unit: object, coords: {row: number, col: number}} | null} 最近的敌人信息或 null
 */
function findNearestEnemy(unitCoords, aiFaction) {
    let nearestEnemy = null;
    let minDistance = Infinity;

    for (let r = 0; r < CONFIG.MAP.ROWS; r++) {
        for (let c = 0; c < CONFIG.MAP.COLS; c++) {
            const enemyUnit = GameState.map.grid[r]?.[c]?.unit;
            if (enemyUnit && enemyUnit.faction !== aiFaction) {
                const distance = calculateHexDistance(unitCoords, { row: r, col: c });
                if (distance < minDistance) {
                    minDistance = distance;
                    nearestEnemy = { unit: enemyUnit, coords: { row: r, col: c } };
                }
            }
        }
    }
    return nearestEnemy;
}

// --- AI 行动逻辑 (保持不变，但暂时不调用) ---
let isAIThinking = false; // 防止 AI 回合重复触发

/**
 * 评估攻击目标的优先级
 * @param {object} attacker 攻击单位
 * @param {object} defender 防守单位
 * @param {string} terrain 防守方所在地形
 * @returns {number} 优先级分数
 */
function evaluateTargetPriority(attacker, defender, terrain) {
    let priority = 0;
    
    // 基于目标剩余血量（优先攻击血量低的）
    const healthRatio = defender.health / defender.stats.maxHealth;
    priority += (1 - healthRatio) * 40;
    
    // 如果防守者健康度很低（可能一击致命），提高优先级
    if (healthRatio < 0.3) {
        priority += 50;
    }
    
    // 基于单位类型的威胁度和价值
    const unitValue = {
        'artillery': 80,  // 火炮高价值，优先攻击
        'tank': 60,       // 坦克次之
        'infantry': 40    // 步兵价值较低
    }[defender.type] || 30;
    
    priority += unitValue;
    
    // 根据防守单位是否在城市中调整优先级
    if (terrain === 'city') {
        // 如果敌人在城市中，提高攻击优先级
        priority += 30;
        
        // 如果城市已被敌方占领，进一步提高优先级
        const cell = GameState.map.grid[defender.coords.row][defender.coords.col];
        if (cell.owner && cell.owner !== attacker.faction) {
            priority += 20;
        }
    }
    
    // 基于地形防御加成（优先攻击在平地等防御低的地形上的单位）
    const terrainDefense = {
        'plain': 0,
        'forest': 2,
        'mountain': 3,
        'city': 2,
        'water': 0
    }[terrain] || 0;
    
    priority -= terrainDefense * 10;
    
    // 如果能击杀目标，大幅提高优先级
    const estimatedDamage = calculateEstimatedDamage(attacker, defender, terrain);
    if (estimatedDamage >= defender.health) {
        priority += 100;
    }
    
    // 如果目标是远程单位且我们在其攻击范围内，提高优先级（优先消灭威胁）
    if (defender.type === 'artillery' && calculateHexDistance(attacker.coords, defender.coords) <= (defender.stats.range || 1)) {
        priority += 40;
    }
    
    return priority;
}

/**
 * 计算估计伤害值
 * @param {object} attacker 攻击单位
 * @param {object} defender 防守单位
 * @param {string} terrain 防守方所在地形
 * @returns {number} 估计伤害值
 */
function calculateEstimatedDamage(attacker, defender, terrain) {
    // 基础伤害
    let damage = attacker.stats.attack;
    
    // 考虑攻击者健康度对伤害的影响
    const attackerHealthRatio = attacker.health / attacker.stats.maxHealth;
    damage *= (0.5 + attackerHealthRatio * 0.5); // 健康度影响伤害，最低降低到50%
    
    // 考虑防御者的防御力和地形加成
    const terrainDefense = {
        'plain': 0,
        'forest': 2,
        'mountain': 3,
        'city': 2,
        'water': 0
    }[terrain] || 0;
    
    const totalDefense = defender.stats.defense + terrainDefense;
    
    // 应用防御减免
    damage = Math.max(1, damage - totalDefense);
    
    // 单位类型相克关系
    if (attacker.type === 'artillery' && defender.type === 'infantry') {
        damage *= 1.5; // 火炮对步兵有效
    } else if (attacker.type === 'tank' && defender.type === 'artillery') {
        damage *= 1.3; // 坦克对火炮有效
    } else if (attacker.type === 'infantry' && defender.type === 'tank') {
        damage *= 1.2; // 步兵对坦克有效（代表反坦克武器）
    }
    
    return Math.floor(damage);
}

/**
 * 评估移动位置的优先级
 * @param {object} unit 要移动的单位
 * @param {{row: number, col: number}} moveCoord 目标位置
 * @param {{row: number, col: number}} enemyCoord 最近敌人位置
 * @returns {number} 优先级分数
 */
function evaluateMovePosition(unit, moveCoord, enemyCoord) {
    let score = 0;
    
    // 获取目标地形
    const terrainType = GameState.map.grid[moveCoord.row][moveCoord.col].terrain;
    
    // 计算与敌人的距离
    const distanceToEnemy = calculateHexDistance(moveCoord, enemyCoord);
    
    // 根据单位类型决定理想距离
    const idealDistance = {
        'artillery': unit.stats.range || 2, // 火炮希望保持在最大射程
        'tank': 1,      // 坦克希望靠近
        'infantry': 1   // 步兵希望直接接触
    }[unit.type] || 1;
    
    // 距离评分（越接近理想距离越好）
    score += 50 - Math.abs(distanceToEnemy - idealDistance) * 10;
    
    // 地形防御加成评分
    const terrainDefense = {
        'plain': 0,
        'forest': 2,
        'mountain': 3,
        'city': 2,
        'water': 0
    }[terrainType] || 0;
    
    score += terrainDefense * 15;
    
    // 对于已损伤的单位，更倾向于选择防御性强的位置
    const healthRatio = unit.health / unit.stats.maxHealth;
    if (healthRatio < 0.6) {
        score += terrainDefense * 20; // 受伤单位更看重地形防御
    }
    
    // 城市占领考虑
    if (terrainType === 'city') {
        const cell = GameState.map.grid[moveCoord.row][moveCoord.col];
        // 如果是未占领的城市，提高分数
        if (!cell.owner) {
            score += 40;
        }
        // 如果是敌方占领的城市，根据情况提高分数
        else if (cell.owner !== unit.faction) {
            score += 60;
        }
        // 如果是己方已占领的城市，提供较小加成
        else {
            score += 10;
        }
    }
    
    // 尝试避免将多个单位聚集在一起（防止AOE伤害和包围）
    let adjacentAlliesCount = 0;
    const neighbors = getHexNeighbors(moveCoord.row, moveCoord.col);
    for (const neighbor of neighbors) {
        const cell = GameState.map.grid[neighbor.row]?.[neighbor.col];
        if (cell?.unit && cell.unit.faction === unit.faction) {
            adjacentAlliesCount++;
        }
    }
    // 邻近有1个友军是好的，但过多会降低评分
    if (adjacentAlliesCount === 1) {
        score += 15; // 有一个友军支援是好的
    } else if (adjacentAlliesCount > 1) {
        score -= (adjacentAlliesCount - 1) * 10; // 过多友军聚集会降低评分
    }
    
    // 检查位置是否暴露于敌方火力
    const exposureScore = evaluatePositionExposure(unit, moveCoord);
    score -= exposureScore;
    
    return score;
}

/**
 * 评估一个位置对敌方火力的暴露程度
 * @param {object} unit 要移动的单位
 * @param {{row: number, col: number}} position 目标位置
 * @returns {number} 暴露分数（越高越危险）
 */
function evaluatePositionExposure(unit, position) {
    let exposureScore = 0;
    
    // 遍历所有敌方单位
    for (let r = 0; r < CONFIG.MAP.ROWS; r++) {
        for (let c = 0; c < CONFIG.MAP.COLS; c++) {
            const cell = GameState.map.grid[r]?.[c];
            if (cell?.unit && cell.unit.faction !== unit.faction) {
                const enemyUnit = cell.unit;
                const distance = calculateHexDistance(position, {row: r, col: c});
                
                // 检查是否在敌方射程内
                const enemyRange = enemyUnit.stats.range || 1;
                if (distance <= enemyRange) {
                    // 增加暴露分数，远程单位的威胁更大
                    let threatValue = 10;
                    if (enemyUnit.type === 'artillery') {
                        threatValue = 20;
                    } else if (enemyUnit.type === 'tank') {
                        threatValue = 15;
                    }
                    
                    // 距离越近威胁越大
                    const distanceFactor = (enemyRange - distance + 1) / enemyRange;
                    exposureScore += threatValue * distanceFactor;
                }
            }
        }
    }
    
    return exposureScore;
}

// ... (evaluatePositionExposure 函数定义结束) ...

/**
 * 执行单个AI回合的函数，返回行动数量
 */
async function executeAITurn() {
    let actionCount = 0;
    const currentFaction = GameState.turn.faction;
    const unitsInfo = findUnitsOfFaction(currentFaction);

    // 优先级排序逻辑 (可以根据需要调整)
    unitsInfo.sort((a, b) => {
        const cellA = GameState.map.grid[a.coords.row][a.coords.col];
        const cellB = GameState.map.grid[b.coords.row][b.coords.col];
        const aOnUnownedCity = cellA.terrain === 'city' && (!cellA.owner || cellA.owner !== currentFaction);
        const bOnUnownedCity = cellB.terrain === 'city' && (!cellB.owner || cellB.owner !== currentFaction);
        if (aOnUnownedCity && !bOnUnownedCity) return -1;
        if (!aOnUnownedCity && bOnUnownedCity) return 1;
        const aIsDamaged = a.unit.health < a.unit.stats.maxHealth;
        const bIsDamaged = b.unit.health < b.unit.stats.maxHealth;
        if (aIsDamaged && !bIsDamaged) return -1;
        if (!aIsDamaged && bIsDamaged) return 1;
        const aIsRanged = (a.unit.stats.range || 1) > 1;
        const bIsRanged = (b.unit.stats.range || 1) > 1;
        if (aIsRanged && !bIsRanged) return -1;
        if (!aIsRanged && bIsRanged) return 1;
        return 0;
    });

    for (const unitInfo of unitsInfo) {
        // 检查点数，确保至少能执行一个动作
        const minActionCost = 1; // 假设移动或攻击至少需要1点
        if (GameState.turn.actionPoints < minActionCost) {
             console.log(`AI ${currentFaction} 行动点数不足 (${GameState.turn.actionPoints})，跳过剩余单位`);
             break; // 点数不足，结束此单位及后续单位的行动
        }

        const unit = unitInfo.unit;
        const unitCoords = unitInfo.coords;
        const cell = GameState.map.grid[unitCoords.row][unitCoords.col];

        // 如果单位已经完成移动和攻击，则跳过
        if (unit.hasMoved && unit.hasAttacked) {
             continue;
        }
        
        await new Promise(resolve => setTimeout(resolve, 100)); // 短暂延迟，模拟思考

        // --- 决策逻辑 ---

        // 1. 尝试占领 (如果可能且有利)
        const captureCost = 2;
        if (cell.terrain === 'city' && (!cell.owner || cell.owner !== currentFaction) &&
            !unit.hasMoved && !unit.hasAttacked && GameState.turn.actionPoints >= captureCost)
        {
            console.log(`AI ${currentFaction} ${unit.type} 尝试占领城市 [${unitCoords.row},${unitCoords.col}]`);
             if (typeof logBattleInfo === 'function') logBattleInfo(`${currentFaction} ${unit.type} 占领位置 (${unitCoords.row},${unitCoords.col}) 的城市`, 'capture');
            cell.owner = currentFaction;
            unit.hasMoved = true;
            unit.hasAttacked = true; // 占领算作完整行动
            GameState.turn.actionPoints -= captureCost;
            actionCount++;
            renderMap(); // 占领后更新地图显示旗帜
            continue; // 完成占领，处理下一个单位
        }

        // 2. 尝试攻击 (如果未攻击过且有合适目标)
        let attackedThisAction = false;
        if (!unit.hasAttacked && GameState.turn.actionPoints > 0) {
            const attackTargets = calculateAttackRange(unitCoords.row, unitCoords.col);
            if (attackTargets.length > 0) {
                let bestTarget = null;
                let bestPriority = -Infinity;
                for (const target of attackTargets) {
                    const targetUnit = GameState.map.grid[target.row]?.[target.col]?.unit;
                    if(targetUnit) { // 确保目标单位存在
                         const targetTerrain = GameState.map.grid[target.row][target.col].terrain;
                         const priority = evaluateTargetPriority(unit, targetUnit, targetTerrain);
                         if (priority > bestPriority) {
                              bestPriority = priority;
                              bestTarget = target;
                         }
                    }
                }

                if (bestTarget) {
                    const attackCost = UNIT_TYPES[unit.type].cost.actionPoints || 1; // 确保有攻击成本
                    if (GameState.turn.actionPoints >= attackCost) {
                        console.log(`AI ${currentFaction} ${unit.type} [${unitCoords.row},${unitCoords.col}] 攻击目标 [${bestTarget.row},${bestTarget.col}]`);
                         if (typeof logBattleInfo === 'function') logBattleInfo(`${currentFaction} ${unit.type} 从 (${unitCoords.row},${unitCoords.col}) 攻击 (${bestTarget.row},${bestTarget.col})`, 'attack');
                        performAttack(unitCoords, bestTarget); // performAttack 会处理行动点和状态更新
                        // 注意：performAttack内部已经设置了 hasAttacked=true, hasMoved=true，并扣除点数
                        attackedThisAction = true;
                        actionCount++;
                        // 攻击后可能无法再移动，但循环会继续检查下一个单位
                    } else {
                         console.log(`AI ${currentFaction} ${unit.type} 攻击点数不足`);
                    }
                }
            }
        }

        // 3. 尝试移动 (如果未移动过，且点数足够)
        // 仅在未执行攻击动作时才考虑移动 (或者设计为移动后攻击)
        if (!unit.hasMoved && !attackedThisAction && GameState.turn.actionPoints > 0) {
             const moveCost = UNIT_TYPES[unit.type].cost.actionPoints || 1; // 确保有移动成本
             if (GameState.turn.actionPoints >= moveCost) {
                 const nearestEnemy = findNearestEnemy(unitCoords, currentFaction);
                 const movementRange = calculateMovementRange(unitCoords.row, unitCoords.col);

                 if (movementRange.length > 0 && nearestEnemy) {
                     let bestMove = null;
                     let bestScore = -Infinity;
                     for (const moveCoord of movementRange) {
                          const score = evaluateMovePosition(unit, moveCoord, nearestEnemy.coords);
                          if (score > bestScore) {
                               bestScore = score;
                               bestMove = moveCoord;
                          }
                     }

                     if (bestMove) {
                          console.log(`AI ${currentFaction} ${unit.type} [${unitCoords.row},${unitCoords.col}] 移动到 [${bestMove.row},${bestMove.col}]`);
                          if (typeof logBattleInfo === 'function') logBattleInfo(`${currentFaction} ${unit.type} 从 (${unitCoords.row},${unitCoords.col}) 移动到 (${bestMove.row},${bestMove.col})`, 'move');

                          // 执行移动
                          const unitToMove = GameState.map.grid[unitCoords.row][unitCoords.col].unit;
                          GameState.map.grid[bestMove.row][bestMove.col].unit = unitToMove;
                          GameState.map.grid[unitCoords.row][unitCoords.col].unit = null; // 清除原位置
                          unitToMove.hasMoved = true;
                          GameState.turn.actionPoints -= moveCost;
                          actionCount++;
                          renderMap(); // 移动后更新地图

                           // 移动后再次尝试攻击 (如果还能攻击且点数足够)
                           // 注意：需要重新计算攻击范围，因为单位位置变了
                           const attackRangeAfterMove = calculateAttackRange(bestMove.row, bestMove.col);
                           if (!unit.hasAttacked && GameState.turn.actionPoints > 0 && attackRangeAfterMove.length > 0) {
                                let bestTargetAfterMove = null;
                                let bestPriorityAfterMove = -Infinity;
                                for (const target of attackRangeAfterMove) {
                                     const targetUnit = GameState.map.grid[target.row]?.[target.col]?.unit;
                                     if(targetUnit) {
                                          const targetTerrain = GameState.map.grid[target.row][target.col].terrain;
                                          const priority = evaluateTargetPriority(unit, targetUnit, targetTerrain);
                                          if (priority > bestPriorityAfterMove) {
                                               bestPriorityAfterMove = priority;
                                               bestTargetAfterMove = target;
                                          }
                                     }
                                }
                                if (bestTargetAfterMove) {
                                     const attackCostAfterMove = UNIT_TYPES[unit.type].cost.actionPoints || 1;
                                     if(GameState.turn.actionPoints >= attackCostAfterMove) {
                                           console.log(`AI ${currentFaction} ${unit.type} 移动后从 [${bestMove.row},${bestMove.col}] 攻击目标 [${bestTargetAfterMove.row},${bestTargetAfterMove.col}]`);
                                            if (typeof logBattleInfo === 'function') logBattleInfo(`${currentFaction} ${unit.type} 移动后从 (${bestMove.row},${bestMove.col}) 攻击 (${bestTargetAfterMove.row},${bestTargetAfterMove.col})`, 'attack');
                                           performAttack(bestMove, bestTargetAfterMove); // performAttack 会处理点数和状态
                                           // unit.hasAttacked = true; // performAttack内部会设置
                                           actionCount++; // 算作一次额外行动？还是攻击算一次？取决于设计
                                     }
                                }
                           }
                     }
                 } else {
                      console.log(`AI ${currentFaction} ${unit.type} [${unitCoords.row},${unitCoords.col}] 没有可移动范围或找不到敌人`);
                 }
            } else {
                 console.log(`AI ${currentFaction} ${unit.type} 移动点数不足`);
            }
        } else if (unit.hasMoved) {
             console.log(`AI ${currentFaction} ${unit.type} [${unitCoords.row},${unitCoords.col}] 已移动过`);
        } else if (attackedThisAction) {
             console.log(`AI ${currentFaction} ${unit.type} [${unitCoords.row},${unitCoords.col}] 本回合已攻击`);
        } else if (GameState.turn.actionPoints <= 0) {
             console.log(`AI ${currentFaction} ${unit.type} [${unitCoords.row},${unitCoords.col}] 没有剩余行动点`);
        }


    } // 结束单位循环

    console.log(`AI ${currentFaction} 回合完成，执行了 ${actionCount} 个主要行动。剩余点数: ${GameState.turn.actionPoints}`);
    updateGameInfoUI(); // 确保UI更新最终点数
    return actionCount; // 返回执行的动作数
}
// ... (executeAITurn 函数定义结束) ...


/**
 * 结束当前回合，轮到下一个阵营
 */
function endTurn() {
    console.log(`阵营 ${GameState.turn.faction} 结束回合`);

    // 重置当前阵营所有单位的行动状态
    for (let r = 0; r < CONFIG.MAP.ROWS; r++) {
        for (let c = 0; c < CONFIG.MAP.COLS; c++) {
            const unit = GameState.map.grid[r]?.[c]?.unit;
            if (unit && unit.faction === GameState.turn.faction) {
                unit.hasMoved = false;
                unit.hasAttacked = false;
            }
        }
    }

    // 清理选择和高亮
    clearSelectionAndHighlights();
    updateUnitInfoUI(null); // 清除侧边栏信息

    // 确定下一个阵营
    const currentIndex = CONFIG.GAME.FACTIONS.indexOf(GameState.turn.faction);
    const nextIndex = (currentIndex + 1) % CONFIG.GAME.FACTIONS.length;
    const nextFaction = CONFIG.GAME.FACTIONS[nextIndex];

    // 如果下一个阵营是玩家阵营，则增加回合数
    if (nextFaction === GameState.init.playerFaction) {
        GameState.turn.current++;
        console.log(`--- 第 ${GameState.turn.current} 回合开始 ---`);
    }

    // 设置下一个阵营和重置行动点数
    GameState.turn.faction = nextFaction;
    GameState.turn.actionPoints = CONFIG.GAME.ACTION_POINTS_PER_TURN;
    console.log(`${nextFaction} 回合开始，行动点数重置为 ${GameState.turn.actionPoints}`);

    // 更新界面信息
    updateGameInfoUI();
    renderMap(); // 重绘地图以清除高亮等

    // 检查是否是AI回合，如果是则触发AI行动
    if (GameState.turn.faction !== GameState.init.playerFaction) {
        showTemporaryMessage(`${GameState.turn.faction} AI 回合开始...`, 2000);
        setTimeout(async () => {
            try {
                await executeAITurn(); // 等待 AI 回合执行完毕
                // AI 回合结束后，自动调用 endTurn 进入下一个阵营
                // 注意：这里加个短暂延迟避免栈溢出或逻辑冲突
                setTimeout(endTurn, 200); 
            } catch (error) {
                GameError.log(`执行AI回合 ${GameState.turn.faction} 时出错: ${error.message}`, 'error');
                // 即使AI出错，也尝试结束其回合，避免游戏卡死
                 setTimeout(endTurn, 200); 
            }
        }, 500); // 给一点延迟让玩家看到界面更新
    } else {
        // 如果是玩家回合开始
        showTemporaryMessage(`第 ${GameState.turn.current} 回合 - 你的回合！行动点数: ${GameState.turn.actionPoints}`, 4000);
    }
}



/**
 * 更新AI回合逻辑
 */
async function runAITurn() {
    if (isAIThinking) return;
    isAIThinking = true;
    console.log(`AI阵营 ${GameState.turn.faction} 开始行动...`);
    GameState.turn.actionPoints = CONFIG.GAME.ACTION_POINTS_PER_TURN; // 重置AI的行动点数

    const aiUnits = findUnitsOfFaction(GameState.turn.faction);
    aiUnits.sort((a, b) => {
        const typePriority = { 'artillery': 2, 'tank': 1, 'infantry': 0 };
        return typePriority[b.unit.type] - typePriority[a.unit.type];
    });

    for (const aiUnitInfo of aiUnits) {
        const { unit, coords } = aiUnitInfo;
        if (unit.hasMoved && unit.hasAttacked) continue;
        
        // 检查行动点数是否足够
        const actionCost = UNIT_TYPES[unit.type].cost.actionPoints;
        if (GameState.turn.actionPoints < actionCost) {
            console.log(`AI行动点数不足，跳过剩余单位`);
            break;
        }

        await new Promise(resolve => setTimeout(resolve, 500));

        // 1. 首先尝试攻击
        const attackTargets = calculateAttackRange(coords.row, coords.col);
        if (attackTargets.length > 0) {
            let bestTarget = null;
            let bestPriority = -Infinity;

            for (const target of attackTargets) {
                const targetUnit = GameState.map.grid[target.row][target.col].unit;
                const targetTerrain = GameState.map.grid[target.row][target.col].terrain;
                const priority = evaluateTargetPriority(unit, targetUnit, targetTerrain);
                
                if (priority > bestPriority) {
                    bestPriority = priority;
                    bestTarget = target;
                }
            }

            if (bestTarget) {
                console.log(`AI ${unit.type} [${coords.row},${coords.col}] 攻击最优目标 [${bestTarget.row},${bestTarget.col}]`);
                performAttack(coords, bestTarget);
                GameState.turn.actionPoints -= actionCost;
                updateGameInfoUI();
                continue;
            }
        }

        // 2. 如果没有攻击或攻击后还能移动，尝试移动
        if (!unit.hasMoved) {
            const nearestEnemy = findNearestEnemy(coords, GameState.turn.faction);
            if (nearestEnemy) {
                const movementRange = calculateMovementRange(coords.row, coords.col);
                if (movementRange.length > 0) {
                    let bestMove = null;
                    let bestScore = -Infinity;

                    for (const moveCoord of movementRange) {
                        const score = evaluateMovePosition(unit, moveCoord, nearestEnemy.coords);
                        if (score > bestScore) {
                            bestScore = score;
                            bestMove = moveCoord;
                        }
                    }

                    if (bestMove) {
                        console.log(`AI ${unit.type} [${coords.row},${coords.col}] 移动到最优位置 [${bestMove.row},${bestMove.col}]`);
                        GameState.map.grid[bestMove.row][bestMove.col].unit = unit;
                        GameState.map.grid[coords.row][coords.col].unit = null;
                        unit.hasMoved = true;
                        renderMap();
                        GameState.turn.actionPoints -= actionCost;
                        updateGameInfoUI();
                    }
                }
            }
        }
    }

    console.log(`AI阵营 ${GameState.turn.faction} 行动结束。剩余行动点数: ${GameState.turn.actionPoints}`);
    isAIThinking = false;
    return Promise.resolve();
}

// --- 游戏逻辑 (恢复 endTurn 逻辑) ---
function endTurn() {
    // ... (endTurn 的完整逻辑恢复) ...
    console.log(`阵营 ${GameState.turn.faction} 结束回合`);
    
    for (let r = 0; r < CONFIG.MAP.ROWS; r++) {
        for (let c = 0; c < CONFIG.MAP.COLS; c++) {
            const unit = GameState.map.grid[r]?.[c]?.unit;
            if (unit && unit.faction === GameState.turn.faction) {
                unit.hasMoved = false;
                unit.hasAttacked = false;
            }
        }
    }
    clearSelectionAndHighlights();
    const currentIndex = CONFIG.GAME.FACTIONS.indexOf(GameState.turn.faction);
    
    if (GameState.turn.faction === GameState.init.playerFaction) {
        let aiIndex = 0;
        const runNextAI = () => {
            if (aiIndex >= CONFIG.GAME.FACTIONS.length) {
                GameState.turn.faction = GameState.init.playerFaction;
                GameState.turn.current++;
                GameState.turn.actionPoints = CONFIG.GAME.ACTION_POINTS_PER_TURN;
                console.log(`--- Round ${GameState.turn.current} ---`);
                console.log(`Player's turn! Action points reset to ${GameState.turn.actionPoints}`);
                showTemporaryMessage(`Round ${GameState.turn.current} - Player's turn! Action points reset to ${GameState.turn.actionPoints}`, 4000);
                updateGameInfoUI();
                renderMap();
                return;
            }
            const nextFaction = CONFIG.GAME.FACTIONS[aiIndex];
            if (nextFaction !== GameState.init.playerFaction) {
                GameState.turn.faction = nextFaction;
                GameState.turn.actionPoints = CONFIG.GAME.ACTION_POINTS_PER_TURN;
                console.log(`${nextFaction} turn! Action points reset to ${GameState.turn.actionPoints}`);
                updateGameInfoUI();
                renderMap();
                setTimeout(() => {
                    executeAITurn().then(() => { // 使用 executeAITurn
                        aiIndex++;
                        runNextAI();
                    });
                }, 500);
            } else {
                aiIndex++;
                runNextAI();
            }
        };
        runNextAI();
    } else {
         // 理论上 AI 回合会自动流转，这里作为保险
        const nextIndex = (currentIndex + 1) % CONFIG.GAME.FACTIONS.length;
        GameState.turn.faction = CONFIG.GAME.FACTIONS[nextIndex];
        GameState.turn.actionPoints = CONFIG.GAME.ACTION_POINTS_PER_TURN;
        updateGameInfoUI();
        renderMap();
         if (GameState.turn.faction !== GameState.init.playerFaction) {
             setTimeout(() => executeAITurn().then(() => endTurn()), 500); // 如果下一个还是 AI，继续执行
         } else {
              console.log(`--- Round ${GameState.turn.current} ---`);
              console.log(`Player's turn! Action points reset to ${GameState.turn.actionPoints}`);
              showTemporaryMessage(`Round ${GameState.turn.current} - Player's turn! Action points reset to ${GameState.turn.actionPoints}`, 4000);
         }
    }
}

// --- 加载界面控制 (保持不变) ---
function updateLoadingText(text) {
    const loadingText = document.querySelector('#loading-screen p');
    if (loadingText) {
        loadingText.textContent = text;
    }
}

function showLoadingScreen() {
    const loadingScreen = document.getElementById('loading-screen');
    if (loadingScreen) {
        loadingScreen.style.display = 'flex';
        GameState.loading.isLoading = true;
        GameError.log('显示加载屏幕');
    } else {
        GameError.log('未找到加载屏幕元素', 'error');
    }
}

function hideLoadingScreen() {
    const loadingScreen = document.getElementById('loading-screen');
    if (loadingScreen) {
        loadingScreen.style.display = 'none';
        GameState.loading.isLoading = false;
        GameError.log('隐藏加载屏幕');
    } else {
        GameError.log('未找到加载屏幕元素', 'error');
    }
}

// --- 六边形位置计算 (暂时不调用) ---
function calculateHexPosition(row, col) {
    // 六边形的宽度和高度
    const hexSize = CONFIG.MAP.HEX_SIZE;
    const hexWidth = Math.sqrt(3) * hexSize;
    const hexHeight = 2 * hexSize;
    
    // 行偏移（奇数行移动半个宽度）
    let xOffset = 0;
    if (row % 2 !== 0) {
        xOffset = hexWidth / 2;
    }
    
    // 计算中心点位置
    const x = col * hexWidth + xOffset;
    const y = row * (hexHeight * 0.75); // 重叠部分
    
    return { x, y };
}

// --- 加载状态与错误处理 (保持不变) ---
function updateLoadingStatus(status, progress = null) {
    GameState.loading.status = status;
    if (progress) {
        GameState.loading.progress = { ...GameState.loading.progress, ...progress };
    }
    updateLoadingText(status);
    GameError.log(`加载状态更新: ${status}`, 'info');
}

function handleLoadingError(error, context) {
    GameState.loading.error = {
        message: error.message,
        context: context,
        timestamp: new Date().toISOString()
    };
    GameError.log(`加载错误 [${context}]: ${error.message}`, 'error');
    updateLoadingText(`加载出错: ${error.message}`);
}

// --- 显示游戏界面 (保持不变) ---
function showGameInterface() {
    const gameInterface = document.getElementById('game-interface');
    if (gameInterface) {
        gameInterface.style.display = 'grid'; // 使用 CSS 中定义的 grid 布局
        GameError.log('显示游戏主界面');
    } else {
        GameError.log('未找到游戏主界面元素', 'error');
    }
}

// --- 设置游戏内事件监听器 (恢复所有监听) ---
function setupGameEventListeners() {
    GameError.log('设置游戏内事件监听器...');
    const endTurnButton = document.getElementById('end-turn-button');
    if (endTurnButton) {
        endTurnButton.addEventListener('click', endTurn);
    }
    ['move-button', 'attack-button', 'capture-button'].forEach(buttonId => {
        const button = document.getElementById(buttonId);
        if (button) {
            button.addEventListener('click', () => {
                GameError.log(`用户点击了 ${buttonId}`);
                handleOperationButton(buttonId); 
            });
        }
    });
    // 注意：地图格子的点击事件在 renderMap 中动态添加
    GameError.log('游戏内事件监听器设置完成');
}

// --- 按钮操作处理 (恢复) ---
function handleOperationButton(buttonId) {
    // ... (handleOperationButton 的完整逻辑恢复) ...
    if (!GameState.map.selectedUnit) {
        GameError.log('没有选中任何单位，无法执行操作', 'warn');
        return;
    }
    const selectedCoords = GameState.map.selectedUnit;
    const selectedUnit = GameState.map.grid[selectedCoords.row][selectedCoords.col].unit;
    if (!selectedUnit || selectedUnit.faction !== GameState.turn.faction) {
        GameError.log('只能操作当前回合阵营的单位', 'warn');
        return;
    }
    if (GameState.turn.faction !== GameState.init.playerFaction) {
        GameError.log('当前不是玩家回合，无法操作', 'warn');
        return;
    }
    switch(buttonId) {
        case 'move-button': handleMoveOperation(selectedUnit, selectedCoords); break;
        case 'attack-button': handleAttackOperation(selectedUnit, selectedCoords); break;
        case 'capture-button': handleCaptureOperation(selectedUnit, selectedCoords); break;
        default: GameError.log(`未知的操作按钮: ${buttonId}`, 'error');
    }
}
function handleMoveOperation(unit, coords) {
    // ... (完整逻辑恢复) ...
    if (unit.hasMoved) { GameError.log('该单位本回合已经移动过', 'warn'); return; }
    GameState.map.highlightedMoves = calculateMovementRange(coords.row, coords.col);
    GameState.map.highlightedAttacks = [];
    GameError.log('请点击目标位置进行移动');
    renderMap();
}
function handleAttackOperation(unit, coords) {
    // ... (完整逻辑恢复) ...
    if (unit.hasAttacked) { GameError.log('该单位本回合已经攻击过', 'warn'); return; }
    GameState.map.highlightedAttacks = calculateAttackRange(coords.row, coords.col);
    GameState.map.highlightedMoves = [];
    if (GameState.map.highlightedAttacks.length === 0) { GameError.log('攻击范围内没有敌方单位', 'warn'); return; }
    GameError.log('请点击敌方单位进行攻击');
    renderMap();
}
function handleCaptureOperation(unit, coords) {
    // ... (完整逻辑恢复) ...
    const terrainType = GameState.map.grid[coords.row][coords.col].terrain;
    if (terrainType !== 'city') { GameError.log('只能占领城市地形', 'warn'); return; }
    const captureActionCost = 2;
    if (GameState.turn.actionPoints < captureActionCost) { GameError.log(`占领需要${captureActionCost}点行动点数，当前只有${GameState.turn.actionPoints}点`, 'warn'); return; }
    if (unit.hasMoved || unit.hasAttacked) { GameError.log('单位本回合已经行动过，无法占领', 'warn'); return; }
    GameState.map.grid[coords.row][coords.col].owner = unit.faction;
    GameState.turn.actionPoints -= captureActionCost;
                unit.hasMoved = true;
                unit.hasAttacked = true;
    GameError.log(`${unit.faction}占领了位于[${coords.row},${coords.col}]的城市`);
    updateGameInfoUI();
        renderMap();
}

// ... (胜利条件, 开发者模式, 重新开始游戏 保持不变) ...

GameError.log('脚本加载完成，等待DOM加载...');