define(['jquery', 'bootstrap', 'frontend', 'echarts', './settings', 'layer'], function ($, undefined, Frontend, echarts, UnitSettings, Layer) {
    
    // 全局变量
    var MINVSP = 1.5;
    var MAXVSP = 10.0;
    var currentOperatingPoint = null;

    const getCookie = (name) => {
        const m = document.cookie.match('(^|;)\\s*' + name + '=([^;]*)');
        return m ? decodeURIComponent(m[2]) : null;
    };
    
    // 插值工具：一维线性
    const interpolate = (x, x1, y1, x2, y2) => {
        if (x2 === x1) return y1;
        const t = (x - x1) / (x2 - x1);
        return y1 + t * (y2 - y1);
    };

    // 基准曲线上根据 Q 取 P

    /* ----------  基准曲线上根据 Q 取 P（不要求全局排序） ---------- */
    // NEW: 支持“原始顺序 + 局部线段插值/外推”，不做任何排序
    const pressureOnCurve = (flow, curvePoints) => {
        if (!Array.isArray(curvePoints) || curvePoints.length === 0) return null;
        if (curvePoints.length === 1) return curvePoints[0].pressure;

        // 1) 先在所有线段里找“跨越目标 flow 的线段”
        //    支持 x1<x2 或 x1>x2 的任意方向
        const crossingSegs = [];
        for (let i = 0; i < curvePoints.length - 1; i++) {
            const p1 = curvePoints[i], p2 = curvePoints[i + 1];
            const x1 = p1.flow, x2 = p2.flow;
            const y1 = p1.pressure, y2 = p2.pressure;

            // 跳过零长或垂直线段（对 flow→pressure 不可插值）
            //if (!isFinite(x1) || !isFinite(x2) || x1 === x2) continue;

            const minx = Math.min(x1, x2), maxx = Math.max(x1, x2);
            if (flow >= minx && flow <= maxx) {
                // 线性插值
                const t = (flow - x1) / (x2 - x1);
                const y = y1 + t * (y2 - y1);
                crossingSegs.push({y, t: Math.abs(t - 0.5)}); // 用 |t-0.5| 衡量“居中程度”
            }
        }
        if (crossingSegs.length) {
            // 多段都跨越，取“最居中”的一段（更稳健，避免尖锐折返附近的偶然选择）
            crossingSegs.sort((a, b) => a.t - b.t);
            return crossingSegs[0].y;
        }

        // 2) 若没有跨越段，做端部外推：取“flow 最接近”的端点，并用其邻点斜率外推
        let bestIdx = 0, bestDx = Infinity;
        for (let i = 0; i < curvePoints.length; i++) {
            const dx = Math.abs((curvePoints[i].flow ?? 0) - flow);
            if (dx < bestDx) { bestDx = dx; bestIdx = i; }
        }
        // 选择与该端点相邻、且与目标 flow 在同一侧的邻点做外推；找不到就退而求其次
        const pickNeighbor = () => {
            const x0 = curvePoints[bestIdx].flow ?? 0;
            const side = Math.sign(flow - x0);
            const left  = bestIdx - 1 >= 0                 ? bestIdx - 1 : null;
            const right = bestIdx + 1 < curvePoints.length ? bestIdx + 1 : null;

            if (side < 0 && left  !== null) return left;
            if (side > 0 && right !== null) return right;
            // 备用：如果同侧没有，就任选有定义的邻点
            if (left  !== null) return left;
            if (right !== null) return right;
            return null;
        };

        const j = pickNeighbor();
        if (j === null) return curvePoints[bestIdx].pressure ?? null;

        const p0 = curvePoints[bestIdx], p1 = curvePoints[j];
        const x0 = p0.flow, x1 = p1.flow;
        const y0 = p0.pressure, y1 = p1.pressure;

        if (!isFinite(x0) || !isFinite(x1) || x0 === x1) {
            return p0.pressure ?? null;
        }
        const slope = (y1 - y0) / (x1 - x0);
        return y0 + slope * (flow - x0);
    };


    const pressureOnCurve2 = (flow, curvePoints) => {
        if (!curvePoints || curvePoints.length === 0) return null;
        if (flow <= curvePoints[0].flow) return curvePoints[0].pressure;
        
        const n = curvePoints.length - 1;
        const last = curvePoints[n];
        if (flow >= last.flow) {
            const pre = curvePoints[n - 1];
            const slope = (last.pressure - pre.pressure) / (last.flow - pre.flow);
            return last.pressure + slope * (flow - last.flow);
        }

        for (let i = 0; i < curvePoints.length - 1; i++) {
            const p1 = curvePoints[i], p2 = curvePoints[i + 1];
            if (flow >= p1.flow && flow <= p2.flow) {
                return interpolate(flow, p1.flow, p1.pressure, p2.flow, p2.pressure);
            }
        }
        return null;
    };

    // 求速度比 k

    /* ----------  求速度比 k ---------- */
    // 根据操作点(OP: flowOP, presOP)与基准曲线，求速度比 k（对无序 curvePoints 友好） 
    const solveSpeedRatio = (flowOP, presOP, curvePoints, tol = 1e-4) => {
        const f = q => {
            const y = pressureOnCurve(q, curvePoints);  // ← 依赖无序友好的 pressureOnCurve
            return (y == null || !isFinite(y)) ? null : y;
        };

        let lo = 0.3, hi = 3.0;

        // 尝试让 f 在边界定义，避免 null 参与计算
        for (let i = 0; i < 8; i++) {
            const fl = f(flowOP / lo), fh = f(flowOP / hi);
            if (fl != null && fh != null) break;
            lo *= 0.9; hi *= 1.1;
        }

        const g = k => {
            const val = f(flowOP / k);
            return (val == null) ? NaN : (k * k) * val - presOP;
        };

        const sign = x => (x > 0 ? 1 : x < 0 ? -1 : 0);
        const safeDiv = (a,b) => (b === 0 ? 0 : a / b);

        let glo = g(lo), ghi = g(hi);

        // 边界都无效时给个保底估计
        if (!isFinite(glo) && !isFinite(ghi)) {
            const ref = curvePoints.find(p => p.flow > 1e-6 && p.pressure > 1e-6) || curvePoints[0];
            const k1  = safeDiv(flowOP , (ref?.flow     ?? 1));
            const k2  = Math.sqrt(safeDiv(presOP, (ref?.pressure ?? 1)));
            const k   = (isFinite(k1) && isFinite(k2)) ? (k1 + k2) / 2 : (isFinite(k1) ? k1 : (isFinite(k2) ? k2 : 1));
            return Math.min(Math.max(k, 0.3), 3.0);
        }

        // 若同号，用保底估计回退（防止卡在无根区间）
        if (sign(glo) === sign(ghi)) {
            const ref = curvePoints.find(p => p.flow > 1e-6 && p.pressure > 1e-6) || curvePoints[0];
            const k1  = safeDiv(flowOP , (ref?.flow     ?? 1));
            const k2  = Math.sqrt(safeDiv(presOP, (ref?.pressure ?? 1)));
            const k   = (isFinite(k1) && isFinite(k2)) ? (k1 + k2) / 2 : (isFinite(k1) ? k1 : (isFinite(k2) ? k2 : 1));
            return Math.min(Math.max(k, lo), hi);
        }

        // 二分求解
        for (let iter = 0; iter < 50; iter++) {
            const mid  = 0.5 * (lo + hi);
            const gmid = g(mid);
            if (isFinite(gmid) && Math.abs(gmid) < tol) return mid;
            if (!isFinite(gmid)) { // mid 无效，尽量往有定义的一侧缩
                const glm = g(lo);
                if (isFinite(glm)) { hi = mid; ghi = g(hi); }
                else { lo = mid; glo = g(lo); }
                continue;
            }
            if (sign(gmid) === sign(glo)) {
                lo = mid; glo = gmid;
            } else {
                hi = mid; ghi = gmid;
            }
        }
        return 0.5 * (lo + hi);
    };

    const solveSpeedRatio2 = (flowOP, presOP, curvePoints, tol = 1e-4) => {
        const f = q => pressureOnCurve(q, curvePoints);
        let lo = 0.3, hi = 3;
        
        for (let i = 0; i < 10 && (f(flowOP / lo) === null || f(flowOP / hi) === null); i++) {
            lo *= 0.9; hi *= 1.1;
        }
        
        const sign = x => (x > 0 ? 1 : x < 0 ? -1 : 0);
        let glo = lo ** 2 * f(flowOP / lo) - presOP;
        let ghi = hi ** 2 * f(flowOP / hi) - presOP;

        if (sign(glo) === sign(ghi)) {
            const k1 = flowOP / curvePoints[0].flow;
            const k2 = Math.sqrt(presOP / curvePoints[0].pressure);
            return (k1 + k2) / 2;
        }

        for (let iter = 0; iter < 40; iter++) {
            const mid = 0.5 * (lo + hi);
            const gmid = mid ** 2 * f(flowOP / mid) - presOP;
            if (Math.abs(gmid) < tol) return mid;
            if (sign(gmid) === sign(glo)) {
                lo = mid; glo = gmid;
            } else {
                hi = mid; ghi = gmid;
            }
        }
        return 0.5 * (lo + hi);
    };

    function toFixedValue(value, unit, num) {
        if ( typeof num != 'undefined' ) {
            return (value-0).toFixed(num);
        }
        if ( unit == 'm³/s' ) {
            return (value-0).toFixed(3);
        }
        if ( unit == 'm³/h' || unit == 'CFM' || unit == 'Pa' || unit == 'W' ) {
            return (value-0).toFixed(0);
        }
        if ( unit == 'bar' ) {
            return (value-0).toFixed(3);
        }
        if ( unit == 'inHG' ) {
            return (value-0).toFixed(3);
        }
        if ( unit == 'psi' || unit == 'inH₂O'  || unit == 'ftWC'  || unit == 'hp') {
            return (value-0).toFixed(3);
        }
        return (value-0).toFixed(2);
    }
    
    
    var Controller = {
        // 存储每个风机的处理后数据
        fanDataProcessed: {},
        // 存储每个风机的图表实例
        fanCharts: {},
        // 存储当前单位设置
        unitSettings: {
            flow: 'm³/h',
            pressure: 'Pa',
            power: 'W',
			speed: 'rpm',
			fanspeed: 'm/s',
			sfp: 'W/m3/s',
			current: 'A',
			temperature: 'C',
			density: 'kg/m³',
			
        },
        
        initUnitSettings () {
            // 1) 读取 localStorage
            // 从本地存储获取单位设置
            var savedSettings = localStorage.getItem('unitSettings');
            if (savedSettings) {
                try {
                    var settings = JSON.parse(savedSettings);
                    
                    // 更新控制器的单位设置
                    if (settings.flow) Controller.unitSettings.flow = settings.flow;
                    if (settings.pressure) Controller.unitSettings.pressure = settings.pressure;
                    if (settings.power) Controller.unitSettings.power = settings.power;
                    if (settings.density) Controller.unitSettings.density = settings.density;
                    if (settings.temperature) Controller.unitSettings.temperature = settings.temperature;
                                        
                } catch (e) {
                    console.error('Failed to parse saved settings:', e);
                }
            }

            // 2) 首屏把单位写进 DOM
            $('.flow-unit').text(Controller.unitSettings.flow);
            $('.pressure-unit').text(Controller.unitSettings.pressure);
            $('.power-unit').text(Controller.unitSettings.power);
        },
        
        index: function () {
            var fanData = gfanData;
            var fanCurves = gfanCurves;
            
            console.log('fanData', fanData);
            console.log('fanCurves', fanCurves);
            
            UnitSettings.init();      // 渲染右上角 “Unit Settings” 面板
            this.initUnitSettings();  // ←←← 新增
            
            // 添加风机数量类到表格
            var fanCount = fanData.length;
            $('.comparison-table-container .table').addClass('fan-count-' + fanCount);
    
            // 处理每个风机的数据
            Controller.processFanData(fanData, fanCurves);
            
            // 生成图表HTML
            //Controller.generateChartsHTML(fanData);

            
            Controller.createBestEfficiencyRow(fanData);   // 新增
            
            // 创建操作点行 20250814
            Controller.createOperatingPointRow(fanData);

    
            // 初始化所有图表
            Controller.initAllCharts();
            
            // 绑定事件
            Controller.bindEvents();
        },


        // 使用新单位更新图表
        updateChartsWithNewUnits: function(settings, oldsettings) {

            const flowFactor     = UnitSettings.conversionFactors.flow[settings.flow];        // m³/h → 新单位
            const pressureFactor = UnitSettings.conversionFactors.pressure[settings.pressure];
            const powerFactor    = UnitSettings.conversionFactors.power[settings.power];

            // 遍历所有图表实例
            $.each(Controller.fanCharts, function (fanId, chart) {

                const fan = Controller.fanDataProcessed[fanId];
                if (!fan) return;

                // 当前图表配置
                const opt = chart.getOption();

                /* 1) 坐标轴标题 */
                opt.xAxis[0].name = __('Flow') + ' (' + settings.flow + ')';
                opt.yAxis[0].name = __('Pressure') + ' (' + settings.pressure + ')';

                /* 2) 原始 VSP 曲线 */
                fan.availableVsps.forEach(function (vsp) {
                    const idx = opt.series.findIndex(s => s.name === vsp + 'V');
                    if (idx === -1) return;          // 没找到就跳过

                    opt.series[idx].data = fan.pqData[vsp].map(pt => [
                        toFixedValue(pt.flow     * flowFactor,     settings.flow),
                        toFixedValue(pt.pressure * pressureFactor, settings.pressure)
                    ]);
                });

                /* 3) 推算曲线 / 操作点 / 最佳效率点 */
                opt.series.forEach(function (s) {
                    if (s.name.indexOf('Calculated') !== -1 ||           // 推算曲线
                        s.name === __('Operating Point')  ||
                        s.name === __('Max Efficiency Point')) {

                        s.data = s.data.map(d => [
                            toFixedValue(d[0] * flowFactor,     settings.flow),
                            toFixedValue(d[1] * pressureFactor, settings.pressure)
                        ]);
                    }
                });

                /* 4) 重新计算坐标范围（留 10% 余量） */
                const allX = [].concat(...opt.series.map(s => s.data.map(p => p[0])));
                const allY = [].concat(...opt.series.map(s => s.data.map(p => p[1])));
                opt.xAxis[0].max = +toFixedValue(Math.max.apply(null, allX) * 1.2, settings.flow);
                opt.yAxis[0].max = +toFixedValue(Math.max.apply(null, allY) * 1.2, settings.pressure);

                /* 5) 应用修改 */
                chart.setOption(opt, true);
            });
            
        },
        
        
        // 处理风机数据
        processFanData: function(fanData, fanCurves) {
            console.log('processFanData');
            fanData.forEach(function(fan) {
                var fanId = fan.id;
                var pqData = fanCurves[fanId] || [];
                
                // 按VSP分组
                var pqDataGrouped = {};
                var availableVsps = [];
                
                // 解析VSP范围
                if (fan.speed_control) {
                    var vspRange = fan.speed_control.split('-');
                    if (vspRange.length === 2) {
                        MINVSP = parseFloat(vspRange[0]);
                        MAXVSP = parseFloat(vspRange[1]);
                    }
                }
                
                // 收集VSP值
                pqData.forEach(function(item) {
                    var vsp = parseFloat(item.vsp || 10);
                    if (availableVsps.indexOf(vsp) === -1) {
                        availableVsps.push(vsp);
                    }
                });
                
                availableVsps.sort(function(a, b) { return a - b; });
                
                let _lastindex = availableVsps.length - 1;
                let _lastvsp = 0;
                if (availableVsps[_lastindex] != MAXVSP) {
                    _lastvsp = availableVsps[_lastindex];
                    availableVsps[_lastindex] = MAXVSP;
                }
            
                // 为每个VSP创建数组
                availableVsps.forEach(function(vsp) {
                    pqDataGrouped[vsp] = [];
                });
                console.log('availableVsps', availableVsps);
                // 分配数据点
                pqData.forEach(function(item) {
                    let vsp = parseFloat(item.vsp || 10);
                    let efficiency = 0;
                    // 将pq里面的最大vsp跟风机参数的speed control保持一致
                    if ( _lastvsp == vsp ) {
                        vsp = MAXVSP;
                    }
                    
                    if (item.efficiency > 0) {
                        efficiency = item.efficiency;
                    } else {
                        if (parseFloat(item.power) > 0 && parseFloat(item.air_flow_m3h) > 0) {
                            efficiency = (parseFloat(item.air_flow_m3h) * parseFloat(item.air_pressure_amend)) / 
                                        (parseFloat(item.power) * 3600) * 100;
                        }
                    }
                    
                    let point = {
                        flow: parseFloat(item.air_flow_m3h || 0),
                        pressure: parseFloat(item.air_pressure_amend || 0),
                        power: parseFloat(item.power || 0),
                        current: parseFloat(item.current || 0),
                        speed: parseInt(item.speed || 0),
                        efficiency: parseFloat(efficiency || 0),
                        noise: parseFloat(item.noise || 0),
                        dy_pressure: parseFloat(item.air_pressure_dynamic || 0),
                        vsp: vsp,
                        originalData: item
                    };
                    
                    pqDataGrouped[vsp].push(point);
                });
                
                // 对每个VSP组内的数据按风量排序
                //for (var vsp in pqDataGrouped) {
                //    pqDataGrouped[vsp].sort(function(a, b) {
                //        return a.flow - b.flow;
                //    });
                //}
                
                // 生成内部VSP数据
                var internalVsps = [];
                var dense = [];
                for (let v = Math.ceil(MINVSP); v <= Math.floor(MAXVSP); v += 1) {
                    dense.push(v);                     // v 本身就是整数
                }

                // ② 统计 already-covered 的整数档（由 avail 推导）
                const intsCovered = new Set(
                    availableVsps.map(v => Math.floor(v))
                );

                // ③ 过滤掉已覆盖整数，只留下“缺失档”
                const denseFiltered = dense.filter(v => !intsCovered.has(v));

                // ④ 合并：先放精确值，再放补档
                const merged = [...availableVsps, ...denseFiltered];

                // ⑤ 去重（极端情况下 avail 里本身有 3，也可能与 denseFiltered 重叠）
                //    然后整体升序，方便之后遍历
                internalVsps = Array.from(new Set(merged)).sort((a, b) => a - b);
            
                for (let v = MINVSP + 1; v <= MAXVSP; v += 1) {
                    internalVsps.push(+v.toFixed(1));
                }
                console.log('allVsps', allVsps);
                
                var allVsps = internalVsps;
                
                allVsps.forEach(v => {
                    if (!pqDataGrouped[v]) {
                        var baseVsp = Controller.findNearestVsp(v, availableVsps);
                        pqDataGrouped[v] = Controller.calculateCurveForVsp(v, baseVsp, pqDataGrouped[baseVsp]);
                    }
                });

                // ---------- 找到该风机最大 VSP ----------
                const maxVsp = Math.max.apply(null, availableVsps);

                // ---------- 找到最大 VSP 曲线里的最高效率点 ----------
                let bestPoint = null;
                (pqDataGrouped[maxVsp] || []).forEach(pt => {
                    if (!bestPoint || pt.efficiency > bestPoint.efficiency) {
                        bestPoint = pt;                       // 记录最高效率点
                    }
                });
        
                Controller.fanDataProcessed[fanId] = {
                    fanInfo: fan,
                    is_AC: fan.is_AC,
                    pqData: pqDataGrouped,
                    availableVsps: availableVsps,
                    internalVsps: allVsps,
                    minVsp: MINVSP,
                    maxVsp: MAXVSP,
                    bestEffPoint: bestPoint          // ← 新字段
                };
                
                console.log('fandata', fanId, {
                    fanInfo: fan,
                    is_AC: fan.is_AC,
                    pqData: pqDataGrouped,
                    availableVsps: availableVsps,
                    internalVsps: allVsps,
                    minVsp: MINVSP,
                    maxVsp: MAXVSP,
                    bestEffPoint: bestPoint          // ← 新字段
                });
            });
        },

        // 找到最近的VSP
        findNearestVsp: function(targetVsp, availableVsps) {
            var nearest = availableVsps[0];
            var minDiff = Math.abs(nearest - targetVsp);
            
            availableVsps.forEach(function(vsp) {
                var diff = Math.abs(vsp - targetVsp);
                if (diff < minDiff) {
                    minDiff = diff;
                    nearest = vsp;
                }
            });
            
            return nearest;
        },

        // 根据风机定律推算新VSP值的曲线
        calculateCurveForVsp: function(targetVsp, baseVsp, basePoints) {
            if (!basePoints || basePoints.length === 0) return [];
            
            var k = targetVsp / baseVsp;
            
            return basePoints.map(function(pt) {
                return {
                    flow: pt.flow * k,
                    pressure: pt.pressure * k * k,
                    power: pt.power * Math.pow(k, 2.998),
                    efficiency: pt.efficiency,
                    vsp: targetVsp,
                    speed: pt.speed * k,
                    dy_pressure: pt.dy_pressure * k * k,
                    noise: pt.noise + 30 * Math.log10(k),
                    current: pt.current,
                    originalData: pt.originalData
                };
            });
        },

        // 生成图表HTML
        generateChartsHTML: function(fanData) {
            var html = '';
            var colClass = fanData.length === 1 ? 'col-md-12' : 'col-md-6';
            
            fanData.forEach(function(fan, index) {
                html += '<div class="' + colClass + '">';
                html += '  <div class="fan-chart-container">';
                html += '    <div class="fan-chart-header">';
                html += '      <span>' + fan.fan_model + '</span>';
                html += '      <small class="text-muted">' + fan.type_name + '</small>';
                html += '    </div>';
                html += '    <div class="fan-chart-body">';
                html += '      <div class="chart-container" id="fan-chart-' + fan.id + '"></div>';
                html += '      <div class="operating-point-info" id="op-info-' + fan.id + '">';
                html += '        <strong>Operating Point:</strong> <span id="op-text-' + fan.id + '">' + __('Click chart to set') + '</span>';
                html += '      </div>';
                html += '    </div>';
                html += '  </div>';
                html += '</div>';
                
                // 每两个图表换行
                if ((index + 1) % 2 === 0) {
                    html += '<div class="clearfix"></div>';
                }
            });
            
            $('#fan-charts-row').html(html);
        },

        // 初始化所有图表
        initAllCharts: function() {
            for (var fanId in Controller.fanDataProcessed) {
                Controller.initFanChart(fanId);
            }
        },
        
// 修改 initFanChart 方法，根据风机数量调整图表配置
initFanChart: function(fanId) {
    var chartDom = document.getElementById('fan-chart-' + fanId);
    if (!chartDom) return;
    
    var fanData = Controller.fanDataProcessed[fanId];
    var myChart = echarts.init(chartDom, null, { renderer: 'canvas' });
    
    // 根据风机总数调整字体大小和间距
    var fanCount = Object.keys(Controller.fanDataProcessed).length;
    var fontSize = fanCount <= 2 ? 11 : fanCount === 3 ? 10 : 9;
    var nameGap = fanCount <= 2 ? 30 : fanCount === 3 ? 25 : 20;
    
    // 准备数据系列
    var series = [];
    var colors = ['#ff0000', '#0000ff', '#00aa00', '#ff00ff', '#ffaa00', '#00ffff'];
    var maxFlow = 0;
    var maxPressure = 0;
    
    // 为每个可见VSP创建一个系列
    fanData.availableVsps.forEach(function(vsp, index) {
        var points = fanData.pqData[vsp] || [];
        var color = colors[index % colors.length];
        
        var seriesData = points.map(function(point) {
            maxFlow = Math.max(maxFlow, point.flow);
            maxPressure = Math.max(maxPressure, point.pressure);
            return [point.flow, point.pressure];
        });
        
        series.push({
            name: vsp + 'V',
            type: 'line',
            data: seriesData,
            smooth: true,
            symbol: 'none',
            symbolSize: 4,
            lineStyle: {
                width: 2,
                color: color
            },
            itemStyle: {
                color: color
            },
            connectNulls: true,
            z: 1
        });
    });
    
    if (fanData.bestEffPoint) {

        series.push({
            name: __('Max Efficiency Point'),
            type: 'scatter',
            data: [[fanData.bestEffPoint.flow, fanData.bestEffPoint.pressure]],
            symbol: 'diamond',
            symbolSize: 12,
            itemStyle: {
                color: '#00cc00'
            },
            label: {
                show: true,
                position: 'top',
                formatter: '{eta|η}{sub|max}',   // η 和 max 分成两个样式
                rich: {
                    eta: {
                      fontSize: 18,
                      lineHeight: 18
                    },
                    sub: {
                      fontSize: 11,                // 小一号
                      lineHeight: 18,              // 与 η 一样高
                      padding: [6, 0, 0, 0],       // 往下挤一点，模拟下标
                    }
                },
                color: '#00cc00'
            },
            z: 9
        });
    }

    var option = {
        title: {
            show: false
        },
        tooltip: {
            trigger: 'axis',
            triggerOn: 'mousemove',
            axisPointer: {
                type: 'cross',
                snap: false,
                lineStyle: {
                    color: '#999',
                    width: 1,
                    type: 'dashed'
                }
            },
            showContent: false
        },
        legend: {
            show: false
        },
        grid: {
            left: '15%',
            right: '10%',
            bottom: '15%',
            top: '8%',
            containLabel: true
        },
        xAxis: {
            type: 'value',
            name: __('Flow') + ' (' + Controller.unitSettings.flow +')',
            nameLocation: 'middle',
            nameGap: nameGap,
            nameTextStyle: {
                fontSize: fontSize
            },
            min: 0,
            max: +toFixedValue(maxFlow * 1.2, Controller.unitSettings.flow),
            axisLabel: {
                fontSize: fontSize - 1
            },
            axisPointer: {
                show: true,
                snap: false
            }
        },
        yAxis: {
            type: 'value',
            name: __('Pressure') + ' (' + Controller.unitSettings.pressure + ')',
            nameLocation: 'middle',
            nameGap: nameGap + 10,
            nameTextStyle: {
                fontSize: fontSize
            },
            min: 0,
            max: +toFixedValue(maxPressure * 1.2, Controller.unitSettings.pressure),
            axisLabel: {
                fontSize: fontSize - 1
            },
            axisPointer: {
                show: true,
                snap: false
            }
        },
        series: series
    };
    
    myChart.setOption(option);
    
    // 绑定点击事件
    Controller.bindChartClick(myChart, fanId);
    
    // 存储图表实例
    Controller.fanCharts[fanId] = myChart;
    
    // 确保图表在容器大小变化时重新调整
    setTimeout(function() {
        myChart.resize();
    }, 100);
},


// 修改 updateOperatingPointInfo 方法，显示操作点信息
updateOperatingPointInfo: function(fanId, flow, pressure, vsp) {
    var fanData = Controller.fanDataProcessed[fanId];
    var infoElement = $('#op-info-' + fanId + ' #op-text-' + fanId);

    // 计算其他参数
    var baseVsp = Controller.findNearestVsp(vsp, fanData.availableVsps);
    var basePoints = fanData.pqData[baseVsp];
    
    var power = 0;
    var speed = 0;
    var efficiency = 0;
    
    if (basePoints && basePoints.length > 0) {
        var k = vsp / baseVsp;
        
        // 通过插值获取基准点的功率
        var basePower = pressureOnCurve(flow / k, basePoints.map(p => ({flow: p.flow, pressure: p.power})));
        power = basePower ? basePower * Math.pow(k, 2.998) : 0;
        
        // 通过插值获取基准点的转速
        var baseSpeed = pressureOnCurve(flow / k, basePoints.map(p => ({flow: p.flow, pressure: p.speed})));
        speed = baseSpeed ? baseSpeed * k : 0;
        
        // 计算效率
        efficiency = Controller.calculateEfficiency(flow, pressure, power);
    }
    
    // 更新简化的文本显示
    var infoText = 'VSP: ' + vsp.toFixed(1) + 'V, Power: ' + power.toFixed(0) + 'W, Eff: ' + efficiency.toFixed(1) + '%';
    infoElement.text(infoText);
    
    // 显示操作点信息区域
    $('#op-info-' + fanId).show();
    
    // 更新表格中的操作点信息
    $('#op-flow-' + fanId).text(flow.toFixed(0));
    $('#op-pressure-' + fanId).text(pressure.toFixed(0));
    $('#op-vsp-' + fanId).text(vsp.toFixed(1));
    $('#op-speed-' + fanId).text(speed.toFixed(0));
    $('#op-power-' + fanId).text(power.toFixed(0));
    $('#op-efficiency-' + fanId).text(efficiency.toFixed(1));
    
    // 显示操作点行
    $('#operating-point-row').show();
},

// 修改清除方法
clearAllCalculatedCurves: function() {
    for (var fanId in Controller.fanCharts) {
        var chart = Controller.fanCharts[fanId];
        var option = chart.getOption();
        
        // 只保留原始VSP曲线
        var originalSeries = option.series.filter(function(s) {
            return s.name.indexOf('Calculated') === -1 && s.name.indexOf('Operating') === -1;
        });
        
        chart.setOption({
            series: originalSeries
        });
    }
    
    // 清空操作点信息
    for (var fanId in Controller.fanDataProcessed) {
        $('#op-info-' + fanId + ' #op-text-' + fanId).text('Click chart to set');
        $('#op-info-' + fanId).hide();
    }
    
    // 隐藏操作点行并重置数据
    $('#operating-point-row').hide();
    $('#operating-point-row span[id^="op-"]').text('-');
    
    currentOperatingPoint = null;
},

        // 绑定图表点击事件
        bindChartClick: function(chart, fanId) {
            chart.getZr().on('click', function(e) {
                var pixelPoint = [e.offsetX, e.offsetY];
                var dataPoint = chart.convertFromPixel('grid', pixelPoint);
                
                if (dataPoint && dataPoint.length >= 2) {
                    var flow = Math.max(0, dataPoint[0]);
                    var pressure = Math.max(0, dataPoint[1]);
                    
                    console.log('Chart clicked:', fanId, 'Point:', flow, pressure);


                    // 设置操作点
                    Controller.setOperatingPoint(flow, pressure);
                    
                    // ① 边界检查 —— 保证点击点落在最上／最下曲线之间
                    /*var boundary = Controller.checkPointBoundary(fanId, flow, pressure);
                   
                    console.log('boundary', boundary);
                    if (boundary.outOfBounds) {
                        pressure = boundary.adjustedPressure; // 把 P 拉回边界

                        // 如果你希望直接把计算曲线固定在最上／最下 VSP，
                        // 可以把 currentOperatingPoint 里的 vsp 一起改掉：
                        // boundary.boundaryVsp 就是 10 V / 1.5 V 那条曲线
                        Controller.showInvalidOperatingPoint(fanId);   // ← 新函数（见下）
                        //return;                         // 不再推算曲线 & 不再更新表格
                    }*/
                    
                    // 为所有风机推算曲线
                    Controller.calculateAllFanCurves(flow, pressure);
                }
            });
        },

        // 清空操作点信息
        showInvalidOperatingPoint: function (fanId) {
            // 图表：去掉之前的推算曲线、操作点
            var chart = Controller.fanCharts[fanId];
            if (chart) {
                var opt = chart.getOption();
                opt.series = opt.series.filter(s =>
                    s.name.indexOf('Calculated') === -1 &&
                    s.name !== 'Operating Point');
                chart.setOption(opt, true);
            }

            // 文本区域
            $('#op-info-' + fanId + ' #op-text-' + fanId).text(__('Invalid point'));
            $('#op-info-' + fanId).show();

            // 表格：全部置为 “-”
            ['flow','pressure','vsp','speed','power','efficiency']
                .forEach(k => $('#op-' + k + '-' + fanId).text('-'));
        },

        // 设置操作点
        setOperatingPoint: function(flow, pressure) {
            currentOperatingPoint = {
                flow: flow,
                pressure: pressure
            };
            
            // 更新输入框
            $('#set-flow').val(flow.toFixed(0));
            $('#set-pressure').val(pressure.toFixed(0));
        },

        // 为所有风机推算曲线
        calculateAllFanCurves: function(flow, pressure) {
            for (var fanId in Controller.fanDataProcessed) {
                Controller.calculateFanOperatingPoint(fanId, flow, pressure);
            }
        },

        // 计算单个风机的操作点和推算曲线
        calculateFanOperatingPoint: function(fanId, flow, pressure) {
            
            var fanData = Controller.fanDataProcessed[fanId];
            if ( fanData.is_AC == 'true' ) {
                return;
            }
            
            var boundary = Controller.checkPointBoundary(fanId, flow, pressure);
            if (boundary.outOfBounds) {
                Controller.showInvalidOperatingPoint(fanId);
                Controller.showOutofRange(fanId);
                return;
            } 
                
            
            
            // 找到最近的VSP曲线
            var nearestVsp = Controller.findNearestVspCurve(fanId, flow, pressure);
            
            // 插值计算目标VSP
            var targetVsp = Controller.interpolateVsp(fanId, flow, pressure, nearestVsp);
            
            // 限制在可用范围内
            targetVsp = Math.max(fanData.minVsp, Math.min(fanData.maxVsp, targetVsp));
            
            console.log('Fan', fanId, 'target VSP:', targetVsp);
            
            // 推算并显示曲线
            Controller.showCalculatedCurve(fanId, targetVsp);
            
            // 更新操作点信息
            Controller.updateOperatingPointInfo(fanId, flow, pressure, targetVsp);
        },


// 修改 createOperatingPointRow 方法
createOperatingPointRow: function(fanData) {
    // 检查是否已存在操作点行
    if ($('#operating-point-row').length > 0) {
        $('#operating-point-row').remove();
    }
    
    // 创建操作点行HTML
    var html = '<tr id="operating-point-row" style="display: none;">';
    html += '<td class="parameter-cell"><strong>' + __('Operating Point') + '</strong></td>';
    
    // 为每个风机创建一列
    fanData.forEach(function(fan) {
        html += '<td class="text-center value-cell">';
        html += '  <table class="table table-condensed table-borderless operating-point-table table-striped table-hover" style="margin: 0;">';
        html += '    <tr>';
        html += '      <td class="op-cell">' + __('Flow') + ': <span id="op-flow-' + fan.id + '">-</span> m³/h</td></tr><tr>';
        html += '      <td class="op-cell">' + __('Pressure') + ': <span id="op-pressure-' + fan.id + '">-</span> Pa</td>';
        html += '    </tr>';
        html += '    <tr>';
        html += '      <td class="op-cell">' + __('Power') + ': <span id="op-power-' + fan.id + '">-</span>W</td></tr><tr>';
        html += '      <td class="op-cell">' + __('Speed') + ': <span id="op-speed-' + fan.id + '">-</span> rpm</td>';
        html += '    </tr>';
        html += '    <tr>';
        html += '      <td class="op-cell">VSP: <span id="op-vsp-' + fan.id + '">-</span>V</td></tr><tr>';
        html += '      <td class="op-cell">' + __('Efficiency') + ': <span id="op-efficiency-' + fan.id + '">-</span>%</td>';
        html += '    </tr>';
        html += '  </table>';
        html += '</td>';
    });
    
    html += '</tr>';

    // 在图表行之后插入操作点行
    var chartRow = $('.chart-row');
    if (chartRow.length > 0) {
        chartRow.after(html);
        console.log($('.chart-row'));
    } else {
        // 如果找不到图表行，插入到tbody的开头
        $('.table tbody').prepend(html);
    }
},

// 最佳效率点
createBestEfficiencyRow: function (fanData) {
    // 如果已存在旧行，先删
    $('#best-efficiency-row').remove();

    let html = '<tr id="best-efficiency-row">';
    html += '<td class="parameter-cell"><strong>' + __('The point of highest efficiency') + '</strong></td>';

    fanData.forEach(function (fan) {
        const p = Controller.fanDataProcessed[fan.id].bestEffPoint || {};
        html += '<td class="text-center value-cell">' +
                    '<table class="table table-condensed operating-point-table table-striped table-hover" style="margin:0;">' +
                        '<tr><td class="op-cell">' + __('Flow')       + ': <span>' + toFixedValue(p.flow,    'm³/h') + '</span> m³/h</td></tr>' +
                        '<tr><td class="op-cell">' + __('Pressure')   + ': <span>' + toFixedValue(p.pressure,'Pa' ) + '</span> Pa</td></tr>' +
                        '<tr><td class="op-cell">VSP: <span>'        + toFixedValue(p.vsp,     'V', 1) + '</span> V</td></tr>' +
                        '<tr><td class="op-cell">' + __('Speed')     + ': <span>' + toFixedValue(p.speed,   'rpm') + '</span> rpm</td></tr>' +
                        '<tr><td class="op-cell">' + __('Power')     + ': <span>' + toFixedValue(p.power,   'W'  ) + '</span> W</td></tr>' +
                        '<tr><td class="op-cell">' + __('Efficiency')+ ': <span>' + toFixedValue(p.efficiency,'%',1)+ '</span> %</td></tr>' +
                    '</table>' +
                '</td>';
    });

    html += '</tr>';

    // 插到曲线行(chart-row)后面、操作点行前面，视觉最友好
    const chartrow = $('.chart-row');
    (chartrow.length ? chartrow : $('.table tbody')).after(html);
},

        // 找到最近的VSP曲线
        findNearestVspCurve: function(fanId, flow, pressure) {
            var fanData = Controller.fanDataProcessed[fanId];
            var minDistance = Infinity;
            var nearestVsp = null;
            
            fanData.availableVsps.forEach(function(vsp) {
                var points = fanData.pqData[vsp];
                var distance = Controller.calculateDistanceToCurve(flow, pressure, points);
                
                if (distance < minDistance) {
                    minDistance = distance;
                    nearestVsp = vsp;
                }
            });
            
            return nearestVsp;
        },

        // 计算点到曲线的最小距离
        calculateDistanceToCurve: function(flow, pressure, curvePoints) {
            var minDistance = Infinity;
            
            if (curvePoints.length === 1) {
                var point = curvePoints[0];
                return Math.sqrt(Math.pow(flow - point.flow, 2) + Math.pow(pressure - point.pressure, 2));
            }
            
            for (var i = 0; i < curvePoints.length - 1; i++) {
                var p1 = curvePoints[i];
                var p2 = curvePoints[i + 1];
                var segmentDistance = Controller.distanceToLineSegment(
                    flow, pressure, p1.flow, p1.pressure, p2.flow, p2.pressure
                );
                minDistance = Math.min(minDistance, segmentDistance);
            }
            
            return minDistance;
        },

        // 计算点到线段的距离
        distanceToLineSegment: function(x, y, x1, y1, x2, y2) {
            var l2 = Math.pow(x2 - x1, 2) + Math.pow(y2 - y1, 2);
            if (l2 === 0) return Math.sqrt(Math.pow(x - x1, 2) + Math.pow(y - y1, 2));
            
            var t = ((x - x1) * (x2 - x1) + (y - y1) * (y2 - y1)) / l2;
            if (t < 0) return Math.sqrt(Math.pow(x - x1, 2) + Math.pow(y - y1, 2));
            if (t > 1) return Math.sqrt(Math.pow(x - x2, 2) + Math.pow(y - y2, 2));
            
            var projX = x1 + t * (x2 - x1);
            var projY = y1 + t * (y2 - y1);
            
            return Math.sqrt(Math.pow(x - projX, 2) + Math.pow(y - projY, 2));
        },

        // 插值计算VSP
        interpolateVsp: function(fanId, flow, pressure, nearestVsp) {
            var fanData = Controller.fanDataProcessed[fanId];
            var basePoints = fanData.pqData[nearestVsp];
            
            if (!basePoints || basePoints.length === 0) return nearestVsp;
            
            var k = solveSpeedRatio(flow, pressure, basePoints);
            var targetVsp = nearestVsp * k;
            
            return targetVsp;
        },

        // 显示超出边界点
        showOutofRange: function(fanId) {
            var fanData = Controller.fanDataProcessed[fanId];
            var chart = Controller.fanCharts[fanId];
            
            if (!chart) return;
           
            // 获取当前图表选项
            var option = chart.getOption();
            
            // 移除之前的推算曲线（名称包含"Calculated"的系列）
            var newSeries = option.series.filter(function(s) {
                return s.name.indexOf('Calculated') === -1 && s.name.indexOf('Operating') === -1;
            });
            
            // 添加操作点标记
            if (currentOperatingPoint) {
                newSeries.push({
                    name: 'Operating Point',
                    type: 'scatter',
                    data: [[currentOperatingPoint.flow, currentOperatingPoint.pressure]],
                    symbol: 'pin',
                    symbolSize: 15,
                    itemStyle: {
                        color: '#ff4500'
                    },
                    label: {
                        show: true,
                        position: 'top',
                        formatter: __('Out Of Range'),
                        color: '#ff4500'
                    },
                    z: 20
                });
            }
            
            // 更新图表
            chart.setOption({
                series: newSeries,
                legend: {
                    data: newSeries.map(function(s) { return s.name; })
                }
            });
        },
        
        // 显示推算曲线
        showCalculatedCurve: function(fanId, targetVsp) {
            var fanData = Controller.fanDataProcessed[fanId];
            var chart = Controller.fanCharts[fanId];
            
            if (!chart) return;
            
            // 计算新曲线数据
            var baseVsp = Controller.findNearestVsp(targetVsp, fanData.availableVsps);
            var newPoints = Controller.calculateCurveForVsp(targetVsp, baseVsp, fanData.pqData[baseVsp]);
            
            if (newPoints.length === 0) return;
            
            // 准备曲线数据
            var curveData = newPoints.map(function(point) {
                return [point.flow, point.pressure];
            });
            
            // 获取当前图表选项
            var option = chart.getOption();
            
            // 移除之前的推算曲线（名称包含"Calculated"的系列）
            var newSeries = option.series.filter(function(s) {
                return s.name.indexOf('Calculated') === -1 && s.name.indexOf('Operating') === -1;
            });
            
            // 添加新的推算曲线
            newSeries.push({
                name: 'Calculated ' + targetVsp.toFixed(1) + 'V',
                type: 'line',
                data: curveData,
                smooth: true,
                symbol: 'none',
                symbolSize: 6,
                lineStyle: {
                    width: 2,
                    color: '#9932CC',  // 使用紫色表示推算曲线
                    type: 'dashed'
                },
                itemStyle: {
                    color: '#ff6b35'
                },
                connectNulls: true,
                z: 10
            });
            
            // 添加操作点标记
            if (currentOperatingPoint) {
                newSeries.push({
                    name: 'Operating Point',
                    type: 'scatter',
                    data: [[currentOperatingPoint.flow, currentOperatingPoint.pressure]],
                    symbol: 'pin',
                    symbolSize: 15,
                    itemStyle: {
                        color: '#ff4500'
                    },
                    label: {
                        show: true,
                        position: 'top',
                        formatter: (targetVsp-0).toFixed(2) + ' V',
                        color: '#ff4500'
                    },
                    z: 20
                });
            }
            
            // 更新图表
            chart.setOption({
                series: newSeries,
                legend: {
                    data: newSeries.map(function(s) { return s.name; })
                }
            });
        },

        // 计算效率
        calculateEfficiency: function(flow, pressure, power) {
            if (power <= 0) return 0;
            return (flow * pressure) / (power * 3600) * 100;
        },

        // 绑定事件
        bindEvents: function() {
            // 计算所有按钮
            $('#calculate-all-points').click(function() {
                var flow = parseFloat($('#set-flow').val());
                var pressure = parseFloat($('#set-pressure').val());
                
                if (isNaN(flow) || isNaN(pressure) || flow <= 0 || pressure <= 0) {
                    Layer.msg('Please enter valid flow and pressure values');
                    return;
                }
                
                Controller.setOperatingPoint(flow, pressure);
                Controller.calculateAllFanCurves(flow, pressure);
            });
            
            // 清除所有曲线按钮
            $('#clear-all-curves').click(function() {
                Controller.clearAllCalculatedCurves();
                $('#set-flow').val('1000');
                $('#set-pressure').val('200');
            });
            
            // 输入框变化事件（可选）
            $('#set-flow, #set-pressure').on('blur', function() {
                var flow = parseFloat($('#set-flow').val());
                var pressure = parseFloat($('#set-pressure').val());
                
                if (!isNaN(flow) && !isNaN(pressure) && flow > 0 && pressure > 0) {
                    if (currentOperatingPoint && 
                        (Math.abs(currentOperatingPoint.flow - flow) > 1 || 
                         Math.abs(currentOperatingPoint.pressure - pressure) > 1)) {
                        // 如果值变化较大，可以提示用户点击计算按钮
                        // Layer.msg('Click "Calculate All" to update curves');
                    }
                }
            });

            // 导出PDF按钮事件
            $(document).on('click', '#export-pdf', function () {
                Layer.msg('Exporting PDF...', {icon: 16, time: 1000, shade: [0.1, '#fff']});
                // 实际导出PDF的代码可以根据需要添加
            });

            /* ---------- 新增：全局监听单位变化 ---------- */
            let showInitOP = false;        
            $(document).on('units:changed', function (e, settings, oldsettings) {
                // 1) 保存最新单位
                Object.assign(Controller.unitSettings, settings);

                // 2) 更新页面里显示单位的小标签
                $('.flow-unit').text(settings.flow);
                $('.pressure-unit').text(settings.pressure);
                $('.power-unit').text(settings.power);

                // 3) 把输入框里的旧值换算到新单位
                if (oldsettings && oldsettings.flow && settings.flow) {
                    const v = $('#set-flow').val();
                    $('#set-flow').val(
                        UnitSettings.convertValue(v, oldsettings.flow, settings.flow, 'flow').toFixed(2)
                    );
                }
                if (oldsettings && oldsettings.pressure && settings.pressure) {
                    const v = $('#set-pressure').val();
                    $('#set-pressure').val(
                        UnitSettings.convertValue(v, oldsettings.pressure, settings.pressure, 'pressure').toFixed(2)
                    );
                }

                // 4) 重绘所有曲线
                Controller.updateChartsWithNewUnits(settings, oldsettings);

                // (可选) 首次切换后把首页搜索条件自动带过来
                if (!showInitOP) {
                    const p = JSON.parse(getCookie('fanSearchParams') || '{}');
                    if (p.airFlow && p.airPressure) {
                        $('#set-flow').val(
                            UnitSettings.convertValue(p.airFlow, 'm³/h', settings.flow, 'flow').toFixed(2)
                        );
                        $('#set-pressure').val(
                            UnitSettings.convertValue(p.airPressure, 'Pa', settings.pressure, 'pressure').toFixed(2)
                        );
                        setTimeout(() => $('#calculate-all-points').trigger('click'), 150);
                    }
                    showInitOP = true;
                }
            });

        },

        // 获取曲线上指定流量的压力值
        getPressureOnVspCurve: function (fanId, vsp, flow) {
            const fanData = Controller.fanDataProcessed[fanId];
            const pts     = fanData && fanData.pqData[vsp];
            if (!pts || pts.length === 0) return null;

            // ① 计算当前曲线真正的流量边界
            let minFlow = Infinity, maxFlow = -Infinity;
            pts.forEach(p => {
                if (p.flow < minFlow) minFlow = p.flow;
                if (p.flow > maxFlow) maxFlow = p.flow;
            });

            // ② 若超出边界直接返回 null，让上层判定越界
            if (flow < minFlow || flow > maxFlow) return null;

            // ③ 在曲线（可乱序）上插值 / 外推
            return pressureOnCurve(flow, pts);
        },

        // 边界检查（如果需要的话）
checkPointBoundary: function (fanId, flow, pressure) {
    const fan   = Controller.fanDataProcessed[fanId];
    const vMin  = fan.minVsp;                 // 1.5 V
    const vMax  = fan.maxVsp;                 // 10 V

    /* ---------- 先检查 “上边 + 左右边” ---------- */
    const pMax = Controller.getPressureOnVspCurve(fanId, vMax, flow);
    if (pMax === null) return { outOfBounds: true, reason: 'flow>maxCurve' };
    if (pressure > pMax) return {
        outOfBounds: true,
        boundaryVsp: vMax,
        adjustedPressure: pMax,
        boundaryType: 'max'
    };

    /* ---------- 再检查下边，但只在 1.5 V 曲线有定义时才比较 ---------- */
    const pMin = Controller.getPressureOnVspCurve(fanId, vMin, flow);
    if (pMin !== null && pressure < pMin) {
        return {
            outOfBounds: true,
            boundaryVsp: vMin,
            adjustedPressure: pMin,
            boundaryType: 'min'
        };
    }

    /* ---------- 都通过就是合法点 ---------- */
    return { outOfBounds: false };
},

        checkPointBoundary3: function(fanId, flow, pressure) {
            var fanData = Controller.fanDataProcessed[fanId];
            if (!fanData) return { outOfBounds: false };
            
            var minVsp = fanData.minVsp;
            var maxVsp = fanData.maxVsp;
            
            var minPressure = Controller.getPressureOnVspCurve(fanId, minVsp, flow);
            var maxPressure = Controller.getPressureOnVspCurve(fanId, maxVsp, flow);
            
            if (minPressure === null || maxPressure === null) {
                return { outOfBounds:true };
            }
            
            if (pressure > maxPressure) {
                return {
                    outOfBounds: true,
                    boundaryVsp: maxVsp,
                    adjustedPressure: maxPressure,
                    boundaryType: 'max'
                };
            }
            
            if (pressure < minPressure) {
                return {
                    outOfBounds: true,
                    boundaryVsp: minVsp,
                    adjustedPressure: minPressure,
                    boundaryType: 'min'
                };
            }
            
            return { outOfBounds: false };
        },

        // 工具函数：生成颜色
        generateColors: function(count) {
            var colors = [
                '#ff0000', '#0000ff', '#00aa00', '#ff00ff', 
                '#ffaa00', '#00ffff', '#aa0000', '#0000aa',
                '#00aa00', '#aa00aa', '#aaaa00', '#00aaaa'
            ];
            
            var result = [];
            for (var i = 0; i < count; i++) {
                result.push(colors[i % colors.length]);
            }
            return result;
        },

        // 响应式处理
        handleResize: function() {
            for (var fanId in Controller.fanCharts) {
                Controller.fanCharts[fanId].resize();
            }
        }
    };
    
    // 页面大小改变时重新调整图表
    $(window).resize(function() {
        Controller.handleResize();
    });
    
    return Controller;
});

