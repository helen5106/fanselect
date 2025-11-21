define(['jquery', 'bootstrap', 'frontend', 'echarts', './settings', 'layer'], function ($, undefined, Frontend, echarts, UnitSettings, Layer) {
    
    const filteredArray = (arr, ritem) => {return arr.filter(item => item !== ritem);};


    const setCookie = (name, value, days) => {
        if (days == null) {   // 会话 cookie
            document.cookie = name + '=' + encodeURIComponent(value) + '; path=/';
            return;
        }
        const date = new Date();
        date.setTime(date.getTime() + days * 864e5);
        document.cookie = name + '=' + encodeURIComponent(value) +
                          '; expires=' + date.toUTCString() + '; path=/';
    };
    
    const getCookie = (name) => {
        const m = document.cookie.match('(^|;)\\s*' + name + '=([^;]*)');
        return m ? decodeURIComponent(m[2]) : null;
    };
    
    /* ----------  插值工具：一维线性 ---------- */
    const interpolate = (x, x1, y1, x2, y2) => {
        if (x2 === x1) return y1;               // 避免除 0
        const t = (x - x1) / (x2 - x1);
        return y1 + t * (y2 - y1);
    };


    /* ----------  基准曲线上根据 Q 取 P ---------- */
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

        
    /* ----------  求速度比 k ---------- */
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


// 20250911
/**
 * 根据操作点和相邻VSP推算新的VSP值
 * 使用线性插值方法基于转速关系
 */
const calculateNewVSP = (flowOP, presOP, vspLow, vspHigh, curveLow, curveHigh) => {
    // 1. 从两条曲线上找到与操作点流量最接近的点来估算转速
    const findClosestPoint = (curve, targetFlow) => {
        if (!curve || curve.length === 0) return null;
        
        let closest = curve[0];
        let minDiff = Math.abs(curve[0].flow - targetFlow);
        
        for (let point of curve) {
            const diff = Math.abs(point.flow - targetFlow);
            if (diff < minDiff) {
                minDiff = diff;
                closest = point;
            }
        }
        return closest;
    };
    
    const pointLow = findClosestPoint(curveLow, flowOP);
    const pointHigh = findClosestPoint(curveHigh, flowOP);
    
    if (!pointLow || !pointHigh) return null;
    
    // 2. 使用风机相似定律估算转速
    // Q1/Q2 = (n1/n2), P1/P2 = (n1/n2)^2
    // 从流量比估算转速比
    const speedRatioFromFlow = flowOP / pointLow.flow;
    // 从压力比估算转速比  
    const speedRatioFromPressure = Math.sqrt(presOP / pointLow.pressure);
    
    // 取平均值作为转速比估算
    const avgSpeedRatio = (speedRatioFromFlow + speedRatioFromPressure) / 2;
    
    // 3. 根据转速比和VSP的线性关系推算新VSP
    // 假设转速与VSP成正比关系：n/n_low = VSP/VSP_low
    // 所以：VSP_new = VSP_low × (n_new/n_low)
    const vspFromLow = vspLow * avgSpeedRatio;
    
    // 同样从高VSP点推算
    const speedRatioFromFlowHigh = flowOP / pointHigh.flow;
    const speedRatioFromPressureHigh = Math.sqrt(presOP / pointHigh.pressure);
    const avgSpeedRatioHigh = (speedRatioFromFlowHigh + speedRatioFromPressureHigh) / 2;
    const vspFromHigh = vspHigh * avgSpeedRatioHigh;
    
    // 4. 取两个推算结果的平均值
    const newVSP = (vspFromLow + vspFromHigh) / 2;
    
    // 5. 限制在合理范围内
    const minVSP = Math.min(vspLow, vspHigh) * 0.5;
    const maxVSP = Math.max(vspLow, vspHigh) * 1.5;
    
    return Math.max(minVSP, Math.min(maxVSP, newVSP));
};

/**
 * 改进的VSP推算函数 - 基于转速线性插值
 */
const solveVSPFromOperatingPoint = (flowOP, presOP, availableVSPs, pqData) => {
    if (!availableVSPs || availableVSPs.length < 2) return null;
    
    // 找到包围操作点的两个VSP
    let vspLow = null, vspHigh = null;
    
    // 先尝试找到性能包围点
    for (let i = 0; i < availableVSPs.length - 1; i++) {
        const vsp1 = availableVSPs[i];
        const vsp2 = availableVSPs[i + 1];
        const curve1 = pqData[vsp1];
        const curve2 = pqData[vsp2];
        
        if (!curve1 || !curve2) continue;
        
        // 检查操作点是否在两条曲线的性能范围内
        const maxFlow1 = Math.max(...curve1.map(p => p.flow));
        const maxFlow2 = Math.max(...curve2.map(p => p.flow));
        const maxPres1 = Math.max(...curve1.map(p => p.pressure));
        const maxPres2 = Math.max(...curve2.map(p => p.pressure));
        
        if (flowOP <= Math.max(maxFlow1, maxFlow2) && 
            presOP <= Math.max(maxPres1, maxPres2)) {
            
            // 进一步检查哪个VSP更适合作为低点和高点
            if (vsp1 < vsp2) {
                vspLow = vsp1;
                vspHigh = vsp2;
            } else {
                vspLow = vsp2;
                vspHigh = vsp1;
            }
            break;
        }
    }
    
    // 如果没找到包围点，使用最接近的两个VSP
    if (!vspLow || !vspHigh) {
        availableVSPs.sort((a, b) => a - b);
        
        // 找到最接近的VSP
        let closestVSP = availableVSPs[0];
        let minDistance = Infinity;
        
        for (let vsp of availableVSPs) {
            const curve = pqData[vsp];
            if (!curve) continue;
            
            // 计算操作点到曲线的最小距离
            let minCurveDistance = Infinity;
            for (let point of curve) {
                const distance = Math.sqrt(
                    Math.pow(point.flow - flowOP, 2) + 
                    Math.pow(point.pressure - presOP, 2)
                );
                minCurveDistance = Math.min(minCurveDistance, distance);
            }
            
            if (minCurveDistance < minDistance) {
                minDistance = minCurveDistance;
                closestVSP = vsp;
            }
        }
        
        // 找到相邻的VSP
        const closestIndex = availableVSPs.indexOf(closestVSP);
        if (closestIndex > 0) {
            vspLow = availableVSPs[closestIndex - 1];
            vspHigh = closestVSP;
        } else if (closestIndex < availableVSPs.length - 1) {
            vspLow = closestVSP;
            vspHigh = availableVSPs[closestIndex + 1];
        } else {
            return null;
        }
    }
    
    // 使用改进的算法计算新VSP
    return calculateNewVSP(
        flowOP, presOP, 
        vspLow, vspHigh, 
        pqData[vspLow], pqData[vspHigh]
    );
};


    /**
     * 计算 series 中 X/Y 最大值并写回 option 里的轴范围
     * 一律留 10% 头寸，避免数据贴边
     */
    function refreshAxisRange(option, axis, unit) {
        const idx  = axis === 'x' ? 0 : 1;      // [flow , pressure] → 0 / 1
        let  maxV  = 0;

        option.series.forEach(s => {
            if (!Array.isArray(s.data)) return;
            s.data.forEach(pt => {
                // 点格式可能是 [x, y] 或 {value:[x,y]}
                const v = Array.isArray(pt) ? (pt[idx] - 0) : (pt.value ? (pt.value[idx] - 0) : 0);
                if (v > maxV) maxV = v;
            });
        });

        option[axis + 'Axis'][0].max = toFixedValue(maxV * 1.1, unit);    // +10 %
        option[axis + 'Axis'][0].axisLabel = option[axis + 'Axis'][0].axisLabel || {};
        option[axis + 'Axis'][0].axisLabel.formatter = function(value) {
            return toFixedValue(value, unit);
        };
        
    }

    const DEFAULT_DENSITY = 1.204;       // 20 ℃ 对应基准密度
    
    const densityFromTemp = (tempC) => {
        return DEFAULT_DENSITY * 293.15 / (tempC + 273.15);
    }
    const tempFromDensity = (rho) => {
        return 293.15 * DEFAULT_DENSITY / rho - 273.15;
    }
    
    // =========== 单位辅助 ===========
    function getTempUnit ()   { return $('select[name="temperatureunit"]').val() || 'C'; }
    function getDensityUnit(){ return $('select[name="densityunit"]').val()      || 'kg/m³'; }

    // 温度 ⇒ 摄氏度
    function toCelsius(val, unit){
        return UnitSettings.conversionFactors.temperatureReverse[unit](val);
    }
    // 摄氏度 ⇒ 指定单位
    function fromCelsius(c, unit){
        return UnitSettings.conversionFactors.temperature[unit](c);
    }

    // 密度 ⇒ kg/m³
    function toKgPerM3(rho, unit){
        return rho / UnitSettings.conversionFactors.density[unit];
    }
    // kg/m³ ⇒ 指定单位
    function fromKgPerM3(rhoKg, unit){
        return rhoKg * UnitSettings.conversionFactors.density[unit];
    }
    
    function verticalName(text, rotateDeg, gap){       // rotateDeg 90 或 -90
        let g = typeof gap != 'undefined' ? gap : 45;
        return {
            name            : text,
            nameLocation    : 'middle',   // 让标题位于轴的中点
            nameGap         : g,         // 距离坐标轴的距离，可自行调整
            nameRotate      : rotateDeg,  // 旋转角度，正 90 是竖着由下往上
            nameTextStyle   : {           // 如果想统一字体也可以放到这
                fontSize : 12,
                align    : 'center',
                verticalAlign : 'middle'
            }
        };
    }
    
    /**
     * 把“显示单位”量换算成“基础单位”量
     * @param {number} vRaw   用户量
     * @param {string} kind   'flow' | 'pressure'
     * @returns {number}      基础单位量
     */
    function toBaseUnit(vRaw, kind){
        const u      = Controller.unitSettings[kind];
        const factor = UnitSettings.conversionFactors[kind][u];   // SI → 显示
        return vRaw / factor;          // 反向
    }

    /**
     * 把“基础单位”量换算成“当前显示单位”量并格式化
     * @param {number} vBase  基础单位量 (m³/s 或 Pa)
     * @param {string} kind   'flow' | 'pressure'
     * @returns {number}      已格式化显示量
     */
    function toDisplayUnit(vBase, kind){
        const u      = Controller.unitSettings[kind];
        const factor = UnitSettings.conversionFactors[kind][u];   // SI → 显示
        //return toFixedValue(vBase * factor, u);
        return (vBase * factor).toFixed(3);
    }

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
    
    var initZK = true;

    var Controller = {
        // 存储PQ数据
        pqData: {},
        newPQdata: [],
        opvsp:0,
        opdata3v: [],
        opdata5v: [],
        opdata8v: [],
        imK:0,//阻抗系数
        impedanceData: [],
        currentDensity: DEFAULT_DENSITY,
        MAXFLOW:0,
        MAXPRESSURE:0,
        // 存储风机信息
        fanInfo: {},
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
        // 图表实例
        charts: {
            pressureFlow: null,
            power: null,
            efficiency: null,
            soundPower: null,
            soundPressure: null,
            soundPressureLevel: null
        },
        // 操作点数据
        operatingPoint: {
            vsp: 0,
            flow: 0,
            pressure: 0,
            temperature: 20,
			speed:0,
			noise:0,
			efficiency:0,
			current:0,
            dy_pressure:0, 
        },
        // 最高效率点数据
        maxEfficiencyPoint: {},
        // 可用的VSP值
        availableVsps: [],
        // 隐藏的VSP值
        internalVsps: [],
        
        hiddenVsps: [],
        visibleVsps: [],//用来替代availableVsps
        
		projectionData: null,
		
        // 初始化函数
        index: function () {
            UnitSettings.init();
            //UnitSettings.loadSavedSettings && UnitSettings.loadSavedSettings();

            // 初始化单位设置
            Controller.initUnitSettings();
            
            // 获取风机信息
            Controller.loadFanInfo();
            
            // 获取PQ数据
            Controller.loadPQData();
    
            // 绑定事件
            Controller.bindEvents();

        },
                
        exportChartAsImage: function(chartInstance, callback) {
            if (!chartInstance) {
                console.error('Chart instance not found');
                return null;
            }
            
            // 检查浏览器是否支持 WebP
            const canvas = document.createElement('canvas');
            const supportsWebP = canvas.toDataURL('image/webp').indexOf('data:image/webp') === 0;
            
            const dataURL = chartInstance.getDataURL({
                type: supportsWebP ? 'webp' : 'jpeg',
                pixelRatio: 2,
                backgroundColor: '#fff'
            });
            
            if (callback && typeof callback === 'function') {
                callback(dataURL);
            }
            
            return dataURL;
        },

		// Function to export all charts
		exportAllCharts: function(callback) {
			const charts = {
				pqCurve: Controller.exportChartAsImage(Controller.charts.pressureFlow),
				powerCurve: Controller.exportChartAsImage(Controller.charts.power),
				efficiencyCurve: Controller.exportChartAsImage(Controller.charts.efficiency)
			};
			
			if (callback && typeof callback === 'function') {
				callback(charts);
			}
			
			return charts;
		},



        // 添加辅助函数：将dataURL转换为Blob
        // 改进的 dataURLtoBlob 函数，支持 SVG 和 Base64 格式
        dataURLtoBlob: function(dataURL) {
            return dataURL;
            // 检查是否是有效的 dataURL
            if (!dataURL || typeof dataURL !== 'string') {
                console.error('Invalid dataURL format');
                return new Blob([], {type: 'image/png'});
            }
            
            try {
                // 分割 dataURL 获取 MIME 类型和数据
                var parts = dataURL.split(',');
                if (parts.length !== 2) {
                    throw new Error('Invalid dataURL format');
                }
                
                var meta = parts[0];
                var data = parts[1];
                var contentType = meta.split(':')[1].split(';')[0];
                
                // 检查编码类型
                var isBase64 = meta.indexOf('base64') !== -1;
                
                var rawData;
                if (isBase64) {
                    // Base64 编码的数据
                    rawData = window.atob(data);
                    var uInt8Array = new Uint8Array(rawData.length);
                    
                    for (var i = 0; i < rawData.length; ++i) {
                        uInt8Array[i] = rawData.charCodeAt(i);
                    }
                    
                    return new Blob([uInt8Array], {type: contentType});
                } else {
                    // 非 Base64 编码的数据（如 SVG）
                    // 对于 SVG，我们需要先解码 URL 编码
                    data = decodeURIComponent(data);
                    return new Blob([data], {type: contentType});
                }
            } catch (e) {
                console.error('Error converting dataURL to Blob:', e);
                return new Blob([], {type: 'image/png'}); // 出错时返回空的 Blob
            }
        },

        // 打开PDF选项模态框
        openPdfOptionsModal: function() {
            $('#pdf-options-modal').modal('show');
        },

        // 生成PDF文件
        generatePdfWithOptions: function() {
            // 获取选项
            var layout = $('input[name="layout"]:checked').val();
            var contentOptions = [];
            $('input[name="content[]"]:checked').each(function() {
                contentOptions.push($(this).val());
            });
            var acclist = [];
            $('input[name="accessories[]"]:checked').each(function() {
                acclist.push($(this).val());
            });
            
            // 显示加载消息
            Layer.msg(__('Generating PDF...'), {icon: 16, time: 0});
            
            // 获取图表作为图像
            var charts = Controller.exportAllCharts();
            
            // 获取风机ID
            var id = Fast.api.query('id');
            if (!id) {
                Layer.msg(__('Fan ID not found'));
                return;
            }
            
            // 创建表单数据
            var formData = new FormData();
            formData.append('id', id);
            formData.append('layout', layout);
            
            formData.append('density', $('#set-density').val());
            formData.append('temperature', $('#set-temp').val());
            
            formData.append('content_options', contentOptions);
            formData.append('acclist', acclist);
            formData.append('connectortxt', $('#connectortxt').val());
            console.log(acclist);
            
            //单位
            if (Controller.unitSettings) {
                formData.append('units', JSON.stringify(Controller.unitSettings));
            }
            
            //操作点
            if (Controller.newPQdata) {
                formData.append('opvsp', (Controller.opvsp - 0).toFixed(2));
                formData.append('opdata', JSON.stringify(Controller.newPQdata));
            }
                
            formData.append('opdata3v', JSON.stringify(Controller.opdata3v));
            formData.append('opdata5v', JSON.stringify(Controller.opdata5v));
            formData.append('opdata8v', JSON.stringify(Controller.opdata8v));
                
            // 添加图表图像
            if (charts.pqCurve) {
                formData.append('pq_chart', charts.pqCurve);
            }
            if (charts.powerCurve) {
                formData.append('power_chart', charts.powerCurve);
            }
            if (charts.efficiencyCurve) {
                formData.append('efficiency_chart', charts.efficiencyCurve);
            }

            
            // 发送请求生成PDF
            $.ajax({
                url: 'fan/generateSpecPdf',
                type: 'POST',
                data: formData,
                processData: false,
                contentType: false,
                xhrFields: {
                    responseType: 'arraybuffer'
                },
                success: function(data, status, xhr) {
                    Layer.closeAll();
                    var blob = new Blob([data], {type: 'application/pdf'});
                    
                    // 检查返回的是否真的是PDF
                    if (blob.size > 0) {
                        // 获取文件名
                        var filename = 'Fan_Specification.pdf';
                        var disposition = xhr.getResponseHeader('Content-Disposition');
                        if (disposition && disposition.indexOf('attachment') !== -1) {
                            var filenameRegex = /filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/;
                            var matches = filenameRegex.exec(disposition);
                            if (matches != null && matches[1]) { 
                                filename = matches[1].replace(/['"]/g, '');
                            }
                        }
                        
                        // 创建下载链接
                        var link = document.createElement('a');
                        link.href = window.URL.createObjectURL(blob);
                        link.download = filename;
                        
                        // 触发下载
                        document.body.appendChild(link);
                        link.click();
                        document.body.removeChild(link);
                        window.URL.revokeObjectURL(link.href);
                        
                        // 关闭模态框
                        $('#pdf-options-modal').modal('hide');
                    } else {
                        Layer.alert(__('Generated PDF is empty. Please try again.'));
                    }
                },
                error: function(xhr) {
                    Layer.closeAll();
                    
                    // 尝试解析错误信息
                    var errorMsg = __('Failed to generate PDF. Please try again later.');
                    if (xhr.responseText) {
                        try {
                            var response = JSON.parse(xhr.responseText);
                            if (response.msg) {
                                errorMsg = response.msg;
                            }
                        } catch(e) {
                            // 如果不是JSON，尝试显示前100个字符
                            if (xhr.responseText.length > 0) {
                                errorMsg += ' Server response: ' + xhr.responseText.substring(0, 100);
                            }
                        }
                    }
                    
                    Layer.alert(errorMsg);
                    console.error('Error response:', xhr);
                }
            });
        },

        downloadSpecification: function() {
            // 打开PDF选项模态框
            Controller.openPdfOptionsModal();
        },


        // 初始化单位设置
        initUnitSettings: function() {
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
                    
                    // 更新页面上的单位显示
                    $('.flow-unit').text(Controller.unitSettings.flow);
                    $('.pressure-unit').text(Controller.unitSettings.pressure);
                    $('.power-unit').text(Controller.unitSettings.power);
                    
                } catch (e) {
                    console.error('Failed to parse saved settings:', e);
                }
            }
            
            // 监听单位变更事件
            let showInitOP = false;
            $(document).on('units:changed', function(e, settings, oldsettings) {
                console.log('units:changed');
                // 更新控制器的单位设置
                if (settings.flow) Controller.unitSettings.flow = settings.flow;
                if (settings.pressure) Controller.unitSettings.pressure = settings.pressure;
                if (settings.power) Controller.unitSettings.power = settings.power;
                if (settings.temperature) Controller.unitSettings.temperature = settings.temperature;
                if (settings.density) Controller.unitSettings.density = settings.density;
                
                // 更新页面上的单位显示 op max
                $('.flow-unit').text(Controller.unitSettings.flow);
                $('.pressure-unit').text(Controller.unitSettings.pressure);
                $('.power-unit').text(Controller.unitSettings.power);

                // 更新select
                $('select[name="flowunit"]').val(Controller.unitSettings.flow);
                $('select[name="pressunit"]').val(Controller.unitSettings.pressure);
                $('select[name="temperatureunit"]').val(Controller.unitSettings.temperature);
                $('select[name="densityunit"]').val(Controller.unitSettings.density);
                
                // 更新图表和数据
                Controller.updateChartsWithNewUnits(settings, oldsettings);
                
                let _pressure_changed = settings.pressure != oldsettings.pressure;
                let _flow_changed     = settings.flow != oldsettings.flow;
                let _power_changed     = settings.power != oldsettings.power;
                let _temp_changed     = settings.temperature != oldsettings.temperature;
                let _density_changed     = settings.density != oldsettings.density;
                
                if ( true ) {
                    let ft = $('.flow-value').data('value');
                    let fnt = UnitSettings.convertValue(ft, 'm³/h', settings.flow, 'flow');
                    $('.flow-value').text( toFixedValue(fnt-0, settings.flow) );
                }
                
                if ( true ) {
                    let pt = $('.pressure-value').data('value');
                    let pnt = UnitSettings.convertValue(pt, 'Pa', settings.pressure, 'pressure');
                    $('.pressure-value').text( toFixedValue(pnt-0, settings.pressure) );
                }
                
                if ( _temp_changed ) {
                    let t = $('#set-temp').val();
                    let nt = UnitSettings.convertValue(t, oldsettings.temperature, settings.temperature, 'temperature');
                    $('#set-temp').val( (nt-0).toFixed(0) );
                    $('#set-temp').trigger('change');
                }
                
                if ( _density_changed ) {
                    let t = $('#set-density').val();
                    let nt = UnitSettings.convertValue(t, oldsettings.density, settings.density, 'density');
                    $('#set-density').val( (nt-0).toFixed(3) );
                    //$('#set-density').trigger('change');
                }
                 // 默认只显示一次
                 if ( !showInitOP ) {
                     let fanSearchParams = getCookie('fanSearchParams');       
                     if (fanSearchParams) {

                         try {
                            const params = JSON.parse(fanSearchParams);
                            // ① 直接使用
                            console.log('操作点参数', params);
                            
                            // ② 如果你要填到页面
                            if ( params.airFlow && params.airPressure ) {
                                $('#set-flow').val( UnitSettings.convertValue(params.airFlow, 'm³/h', settings.flow, 'flow') );
                                $('#set-pressure').val( UnitSettings.convertValue(params.airPressure, 'Pa', settings.pressure, 'pressure') );
                            
                                setTimeout( () => $('#calculate-point').trigger('click'), 123);
                            }


                         } catch (e) {
                            console.warn('fanSearchParams 解析失败', e);
                         }
                     }  
                     showInitOP = true;
                 }
            
            });
        },
        
        // 加载风机信息
        loadFanInfo: function() {
            var id = Fast.api.query('id');
            if (!id) {
                Layer.msg(__('Fan ID not found'));
                return;
            }
            
            Fast.api.ajax({
                url: 'fan/getFanInfo',
                data: {id: id}
            }, function(data) {
                Controller.fanInfo = data;
                
                // 更新页面上的风机信息
                Controller.updateFanInfo(data);
                
                return false;
            });
        },

		// 根据点击位置计算VSP值
		calculateVspFromPoint: function(flow, pressure) {
			// 找到最接近的已知VSP曲线
			var closestVsp = null;
			var minDistance = Infinity;
			
			// 遍历所有VSP值
			for (var vsp in Controller.pqData) {
                let _vsp = parseFloat(vsp);
                if ( Controller.availableVsps.includes(_vsp) ) {
					var points = Controller.pqData[vsp];
					
					// 在该VSP曲线上找到最接近的点
					for (var i = 0; i < points.length; i++) {
						var point = points[i];
						var distance = Math.sqrt(
							Math.pow(flow - point.flow, 2) + 
							Math.pow(pressure - point.pressure, 2)
						);
						
						if (distance < minDistance) {
							minDistance = distance;
							closestVsp = parseFloat(vsp);
						}
					}
				}
			}
			
			return closestVsp;
		},


		// 找到最接近点击位置的VSP曲线
		findNearestVspCurve: function(flow, pressure, closestVsp) {
			var minDistance = Infinity;
			var nearestVsp = null;
			
			// 遍历所有VSP值
			for (var vsp in Controller.pqData) {
                let _vsp = parseFloat(vsp);
                let vspArr = typeof closestVsp != 'undefined' ?  Controller.internalVsps :  Controller.availableVsps;
                if ( vspArr.includes(_vsp) ) {
                    let points = Controller.pqData[vsp];
                    
                    // 计算点到曲线的最小距离
                    let curveDistance = Controller.calculateDistanceToCurve(flow, pressure, points);
                    
                    if (curveDistance < minDistance) {
                        minDistance = curveDistance;
                        nearestVsp = parseFloat(vsp);
                    }
                }
			}
			
			return nearestVsp;
		},

		// 计算点到曲线的最小距离
		calculateDistanceToCurve: function(flow, pressure, curvePoints) {
			var minDistance = Infinity;
			
			// 如果曲线只有一个点，直接计算距离
			if (curvePoints.length === 1) {
				var point = curvePoints[0];
				return Math.sqrt(Math.pow(flow - point.flow, 2) + Math.pow(pressure - point.pressure, 2));
			}
			
			// 对于曲线上的每个线段，计算点到线段的距离
			for (var i = 0; i < curvePoints.length - 1; i++) {
				var p1 = curvePoints[i];
				var p2 = curvePoints[i + 1];
				
				// 计算点到线段的距离
				var segmentDistance = Controller.distanceToLineSegment(
					flow, pressure,
					p1.flow, p1.pressure,
					p2.flow, p2.pressure
				);
				
				minDistance = Math.min(minDistance, segmentDistance);
			}
			
			return minDistance;
		},

		// 计算点到线段的距离
		distanceToLineSegment: function(x, y, x1, y1, x2, y2) {
			// 计算线段长度的平方
			var l2 = Math.pow(x2 - x1, 2) + Math.pow(y2 - y1, 2);
			
			// 如果线段长度为0，则直接计算点到端点的距离
			if (l2 === 0) return Math.sqrt(Math.pow(x - x1, 2) + Math.pow(y - y1, 2));
			
			// 计算点在线段上的投影比例
			var t = ((x - x1) * (x2 - x1) + (y - y1) * (y2 - y1)) / l2;
			
			// 如果投影在线段外，则返回到端点的距离
			if (t < 0) return Math.sqrt(Math.pow(x - x1, 2) + Math.pow(y - y1, 2));
			if (t > 1) return Math.sqrt(Math.pow(x - x2, 2) + Math.pow(y - y2, 2));
			
			// 计算投影点坐标
			var projX = x1 + t * (x2 - x1);
			var projY = y1 + t * (y2 - y1);
			
			// 返回点到投影点的距离
			return Math.sqrt(Math.pow(x - projX, 2) + Math.pow(y - projY, 2));
		},

        // 根据点击位置插值计算目标VSP
        interpolateVsp2: function(flow, pressure, nearestVsp) {

            // ① 求目标 VSP
            // let targetVsp = Controller.getinterpolateVsp(flow, pressure, Controller.internalVsps); // 用老函数也行
            let targetVsp = Controller.solveVsp2D(flow, pressure);

            // ② clamp 到允许区间
            targetVsp = Math.min(Math.max(targetVsp, MINVSP), MAXVSP);

            // ③ 选一条“离得最近”的基准曲线，后面 calculateCurveForVsp 要用
            let baseVsp = Controller.internalVsps.reduce(
                (best,v)=>Math.abs(v-targetVsp) < Math.abs(best-targetVsp) ? v : best,
                Controller.internalVsps[0]
            );

            // ④ 记录投影信息（供 calculateCurveForVsp 内部读取）
            Controller.projectionData = {
                baseVsp,
                speedRatio : targetVsp / baseVsp,   // 以后如果要显示 k 可以留着
                targetVsp,
                targetPoint: {flow, pressure}
            };

            console.log('[2D‑interp] targetVsp =', targetVsp.toFixed(2), '  baseVsp =', baseVsp);

            return targetVsp;
        },

        interpolateVsp: function(flow, pressure, nearestVsp) {
            let basePoints = Controller.pqData[nearestVsp];
            if (!basePoints || basePoints.length === 0) return nearestVsp;
                
            let Qmax = Controller.MAXFLOW;    
            // 1. 求速度比 k
            let k = flow > Qmax ? flow / Qmax : solveSpeedRatio(flow, pressure, basePoints);
                //k = isFinite(k) ? 1 : k;
            let targetVsp = nearestVsp * k;
                
            if ( targetVsp > MAXVSP ) {
                targetVsp = MAXVSP;
            }
            if ( targetVsp < MINVSP ) {
                targetVsp = MINVSP;
            }
            // 2. 保存投影数据（便于后续使用）
            Controller.projectionData = {
                baseVsp      : nearestVsp,
                speedRatio   : k,
                targetVsp    : targetVsp,
                targetPoint  : { flow, pressure }
            };
            console.log('k =', k.toFixed(4), '  targetVsp =', targetVsp.toFixed(3));
            return targetVsp;
        },

		// 找到点在曲线上的投影
		findProjectionOnCurve: function(flow, pressure, curvePoints) {
			var minDistance = Infinity;
			var projectionPoint = null;
			
			// 对于曲线上的每个线段，找到最近的投影点
			for (var i = 0; i < curvePoints.length - 1; i++) {
				var p1 = curvePoints[i];
				var p2 = curvePoints[i + 1];
				
				// 计算点到线段的投影
				var projection = Controller.projectPointToLineSegment(
					flow, pressure,
					p1.flow, p1.pressure,
					p2.flow, p2.pressure
				);
				
				var distance = Math.sqrt(
					Math.pow(flow - projection.flow, 2) + 
					Math.pow(pressure - projection.pressure, 2)
				);
				
				if (distance < minDistance) {
					minDistance = distance;
					projectionPoint = projection;
				}
			}
			
			// 如果没有找到投影点（可能曲线只有一个点），返回曲线上最近的点
			if (!projectionPoint) {
				var closestPoint = null;
				minDistance = Infinity;
				
				for (var i = 0; i < curvePoints.length; i++) {
					var point = curvePoints[i];
					var distance = Math.sqrt(
						Math.pow(flow - point.flow, 2) + 
						Math.pow(pressure - point.pressure, 2)
					);
					
					if (distance < minDistance) {
						minDistance = distance;
						closestPoint = point;
					}
				}
				
				projectionPoint = closestPoint;
			}
			
			return projectionPoint;
		},

		// 计算点到线段的投影
		projectPointToLineSegment: function(x, y, x1, y1, x2, y2) {
			// 计算线段长度的平方
			var l2 = Math.pow(x2 - x1, 2) + Math.pow(y2 - y1, 2);
			
			// 如果线段长度为0，则返回端点
			if (l2 === 0) return { flow: x1, pressure: y1 };
			
			// 计算点在线段上的投影比例
			var t = ((x - x1) * (x2 - x1) + (y - y1) * (y2 - y1)) / l2;
			
			// 限制t在[0,1]范围内
			t = Math.max(0, Math.min(1, t));
			
			// 计算投影点坐标
			var projX = x1 + t * (x2 - x1);
			var projY = y1 + t * (y2 - y1);
			
			return { flow: projX, pressure: projY };
		},

		// 根据风机定律推算新VSP值的曲线
        calculateCurveForVsp: function(targetVsp, bvsp) {
            // 2025.08.06 更新算法        
            let baseVsp;
            
            // 优先使用传入的 bvsp 参数
            if (typeof bvsp !== 'undefined') {
                baseVsp = bvsp - 0;
            } else if (Controller.projectionData?.baseVsp && Controller.pqData[Controller.projectionData.baseVsp]) {
                // 其次使用 projectionData 里的基准 VSP
                baseVsp = Controller.projectionData.baseVsp;
            } else {
                // 最后使用"离得最近"策略
                let vspArr = Controller.internalVsps.length > 0 ? Controller.internalVsps : Controller.availableVsps;
                baseVsp = vspArr[0];
                let minDiff = Math.abs(baseVsp - targetVsp);
                vspArr.forEach(v => {
                    let d = Math.abs(v - targetVsp);
                    if (d < minDiff) { minDiff = d; baseVsp = v; }
                });
            }
            
            // 确保 baseVsp 有效
            let basePts = Controller.pqData[baseVsp];
            if (!basePts || basePts.length === 0) return [];

            let k = targetVsp / baseVsp;
            console.log('------推算vsp------')
            console.log('calculateCurveForVsp, baseVsp', baseVsp);
            console.log('calculateCurveForVsp, targetVsp', targetVsp);
            console.log('calculateCurveForVsp, Controller.projectionData', Controller.projectionData);
            console.log('calculateCurveForVsp, K', k);
            
            if (Math.abs(k - 1) < 0.0001) { // 使用小的容差处理浮点数比较
                console.log('k=1，直接返回baseVsp原始数据，避免计算误差');
                
                // 直接返回原始数据，只更新vsp字段
                return basePts.map(pt => ({
                    ...pt,
                    vsp: targetVsp // 确保vsp字段正确
                }));
            }
            
            let newPts = basePts.map(pt => {
                let N2 = pt.speed    * k;
                let Q2 = pt.flow     * k;
                let P2 = pt.pressure * k * k;
                let FP2 = pt.dy_pressure * k * k;
                let W2 = pt.power * Math.pow(k, 2.998);//pt.power    * k * k * k;
                let η2 = (Q2 * P2) / (W2 * 3600) * 100;
                let No2 = 55 + 0.5*(3.14 * FAN_DIMM * N2/60/1000 -10);//(pt.noise - 0) + 30 * Math.log10(k);
                let fη2 = (Q2 * (P2+FP2)) / (W2 * 3600) * 100;
                return { flow: Q2, pressure: P2, power: W2, efficiency: η2, vsp: targetVsp, speed: N2, dy_pressure: FP2, noise: No2, fefficiency: fη2};
            });
                    
            // ===== 新增：强制曲线经过操作点 =====
            if (Controller.projectionData && Controller.projectionData.targetPoint) {
                const targetPoint = Controller.projectionData.targetPoint;
                const targetFlow = targetPoint.flow;
                const targetPressure = targetPoint.pressure;
                
                // 在推算曲线中找到最接近目标流量的两个点进行插值修正
                let insertIndex = -1;
                let needInsert = true;
                
                for (let i = 0; i < newPts.length - 1; i++) {
                    if (newPts[i].flow <= targetFlow && newPts[i + 1].flow >= targetFlow) {
                        // 找到目标流量所在的区间
                        insertIndex = i + 1;
                        
                        // 如果已经有很接近的点，就直接修正
                        if (Math.abs(newPts[i].flow - targetFlow) < 5) {
                            newPts[i].pressure = targetPressure;
                            // 重新计算该点的其他参数
                            newPts[i].efficiency = (newPts[i].flow * newPts[i].pressure) / (newPts[i].power * 3600) * 100;
                            newPts[i].fefficiency = (newPts[i].flow * (newPts[i].pressure + newPts[i].dy_pressure)) / (newPts[i].power * 3600) * 100;
                            needInsert = false;
                        } else if (Math.abs(newPts[i + 1].flow - targetFlow) < 5) {
                            newPts[i + 1].pressure = targetPressure;
                            // 重新计算该点的其他参数
                            newPts[i + 1].efficiency = (newPts[i + 1].flow * newPts[i + 1].pressure) / (newPts[i + 1].power * 3600) * 100;
                            newPts[i + 1].fefficiency = (newPts[i + 1].flow * (newPts[i + 1].pressure + newPts[i + 1].dy_pressure)) / (newPts[i + 1].power * 3600) * 100;
                            needInsert = false;
                        }
                        break;
                    }
                }
                
                // 如果需要插入新点
                if (needInsert && insertIndex > -1) {
                    // 在两个点之间插值计算其他参数
                    const p1 = newPts[insertIndex - 1];
                    const p2 = newPts[insertIndex];
                    const ratio = (targetFlow - p1.flow) / (p2.flow - p1.flow);
                    
                    const interpolatedPoint = {
                        flow: targetFlow,
                        pressure: targetPressure, // 使用目标压力
                        power: p1.power + ratio * (p2.power - p1.power),
                        speed: p1.speed + ratio * (p2.speed - p1.speed),
                        dy_pressure: p1.dy_pressure + ratio * (p2.dy_pressure - p1.dy_pressure),
                        noise: p1.noise + ratio * (p2.noise - p1.noise),
                        vsp: targetVsp
                    };
                    
                    // 重新计算效率
                    interpolatedPoint.efficiency = (interpolatedPoint.flow * interpolatedPoint.pressure) / (interpolatedPoint.power * 3600) * 100;
                    interpolatedPoint.fefficiency = (interpolatedPoint.flow * (interpolatedPoint.pressure + interpolatedPoint.dy_pressure)) / (interpolatedPoint.power * 3600) * 100;
                    
                    // 插入新点
                    newPts.splice(insertIndex, 0, interpolatedPoint);
                }
                
                // 对曲线进行平滑处理，确保经过操作点后曲线仍然合理 20250922
                //newPts.sort((a, b) => a.pressure - b.pressure);
            }

            return newPts;
        },
            
		// Calculate system impedance curve points
		calculateImpedanceCurve: function(operatingPoint) {
			if (!operatingPoint || operatingPoint.flow <= 0 || operatingPoint.pressure <= 0) {
				return [];
			}
			
			// Calculate k coefficient: P = k * Q²
			var k = operatingPoint.pressure / Math.pow(operatingPoint.flow, 2);
			
			// Generate points for the curve
			var points = [];
			var maxFlow = operatingPoint.flow * 1.2; // Extend a bit beyond the operating point
			
			// Generate about 50 points for smooth curve
			for (var i = 0; i <= 50; i++) {
				var flow = (maxFlow * i) / 50;
				var pressure = k * Math.pow(flow, 2);
				points.push([flow, pressure]);
			}
			
			return points;
		},
        
        calculateImpedanceCurve_BAK: function(operatingPoint) {
            if (!operatingPoint || operatingPoint.flow <= 0 || operatingPoint.pressure <= 0) {
                return [];
            }
            
            var k = operatingPoint.pressure / Math.pow(operatingPoint.flow, 2);
            var points = [];
            var maxFlow = operatingPoint.flow * 1.2;
            
            // 使用非线性分布 - 在低流量区域点更密集，高流量区域点更稀疏
            var steps = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0];
            
            for (var i = 0; i < steps.length; i++) {
                var flow = maxFlow * steps[i];
                var pressure = k * Math.pow(flow, 2);
                points.push([flow, pressure]);
            }
            
            return points;
        },

        calculateImpedanceCurveSI: function(opDisplay){
            // 把 operatingPoint 从“显示单位”转换成“基础单位”
            const q0 = opDisplay.flow;     // m³/s
            const p0 = opDisplay.pressure; // Pa
            if(q0<=0 || p0<=0) return [];

            const K  = p0 / Math.pow(q0, 2);          // 基础单位下的一条常数
            console.log('K,', K);
            Controller.imK = K;
            const ptsSI = [];                         // 全部用 SI 单位
            const maxQ  = q0 * 1.3;                   // 画到 1.3×工况点
            for(let i=0; i<=60; i++){
                const q = maxQ * i / 60;
                ptsSI.push([q, K*q*q]);               // [m³/s , Pa]
            }
            return ptsSI;
        },
        
        // 添加曲线简化函数
        simplifyImpedanceCurve: function(points, tolerance = 0.1) {
            if (points.length <= 2) return points;
            
            const simplified = [points[0]]; // 保留第一个点
            
            for (let i = 1; i < points.length - 1; i++) {
                const prev = simplified[simplified.length - 1];
                const curr = points[i];
                const next = points[i + 1];
                
                // 计算当前点到前后点连线的距离
                const distance = Controller.pointToLineDistance(curr, prev, next);
                
                // 如果距离大于容差，保留这个点
                if (distance > tolerance) {
                    simplified.push(curr);
                }
            }
            
            simplified.push(points[points.length - 1]); // 保留最后一个点
            return simplified;
        },

        // 点到直线距离计算
        pointToLineDistance: function(point, lineStart, lineEnd) {
            const [x, y] = point;
            const [x1, y1] = lineStart;
            const [x2, y2] = lineEnd;
            
            const A = y2 - y1;
            const B = x1 - x2;
            const C = x2 * y1 - x1 * y2;
            
            return Math.abs(A * x + B * y + C) / Math.sqrt(A * A + B * B);
        },


		// Draw or update the impedance curve on the chart
		drawImpedanceCurve: function(op) {

			if (!Controller.charts.pressureFlow || !Controller.operatingPoint) {
				return;
			}
			
			// Calculate impedance curve points
			var impedancePoints = Controller.calculateImpedanceCurve( typeof op == 'undefined' ? Controller.operatingPoint : op );
			if (impedancePoints.length === 0) {
				return;
			}
            Controller.impedanceData = impedancePoints;
            console.log('impedanceData:', Controller.impedanceData);

            // ===== 防止阻抗曲线超出太多最大风量和最大静压 =====
            var option = Controller.charts.pressureFlow.getOption();
            var maxFlowInChart =  Controller.MAXFLOW;
            var maxPressureInChart =  Controller.MAXPRESSURE
            
            console.log('Controller.MAXFLOW,', Controller.MAXFLOW);
            console.log('Controller.MAXPRESSURE,', Controller.MAXPRESSURE);
            
            // 限制阻抗曲线的最大流量为风机曲线最大流量的1.2倍
            var maxFlowForImpedance = maxFlowInChart * 1.15;
            var maxPressureForImpedance = maxPressureInChart * 1.15; // 新增压力限制
            
            // 转换单位并限制范围
            impedancePoints = impedancePoints.map(([qSI, pSI]) => {
                const displayFlow = +toDisplayUnit(qSI, 'flow');
                const displayPressure = +toDisplayUnit(pSI, 'pressure');
                return [displayFlow, displayPressure];
            }).filter(([flow, pressure]) => {
                // 过滤掉超出合理范围的点
                return flow <= maxFlowForImpedance && pressure <= maxPressureForImpedance;
            });
            Controller.impedanceData = Controller.simplifyImpedanceCurve(impedancePoints);
            console.log('impedanceData2:', Controller.impedanceData);
            
			// Find if impedance curve already exists
			var impedanceIndex = -1;
			for (var i = 0; i < option.series.length; i++) {
				if (option.series[i].name === __('System Impedance')) {
					impedanceIndex = i;
					break;
				}
			}
			
			// Create or update the impedance curve series
			if (impedanceIndex === -1) {
				// Add new impedance curve series
				option.series.push({
					name: __('System Impedance'),
					type: 'line',
					data: impedancePoints,
					smooth: true,
					symbol: 'none',
                    //smoothMonotone: 'x', 
					lineStyle: {
						width: 2,
						color: '#FF8C00',  // Dark orange color
						type: 'dashed'
					},
					itemStyle: {
						color: '#FF8C00'
					},
					connectNulls: true,
					z: 5  // Make sure it's above the fan curves but below the operating point
				});
				
                
			} else {
				// Update existing impedance curve
				option.series[impedanceIndex].data = impedancePoints;
			}
			
			// Apply the updated options
			Controller.charts.pressureFlow.setOption(option);
		},
        
        //隐藏vsp    
        hideVspSeries: (vsp) => {
            ['pressureFlow', 'power', 'efficiency', 'noise'].forEach(function (chartKey) {
                var chart = Controller.charts[chartKey];
                if (!chart) return;
                var opt = chart.getOption();

                // 1) 过滤 series
                if (opt.series) {
                    opt.series = opt.series.filter(function (s) {
                        return s.name !== vsp + 'V';
                    });
                }
                // 2) 过滤 legend（即使 legend 不显示，selected 依然生效）
                if (opt.legend && opt.legend.data) {
                    opt.legend.data = opt.legend.data.filter(function (n) {
                        return n !== vsp + 'V';
                    });
                }
                // 3) 应用更新
                chart.setOption(opt, true);
            });

            // 更新内部可见/隐藏列表
            //Controller.hiddenVsps.push(vsp);
            //Controller.visibleVsps = Controller.visibleVsps.filter(function (v) { return v != vsp && v != MAXVSP; });
        },

		// 在图表上显示推算的曲线
		showCalculatedCurve: function(targetVsp) {
            // 计算新VSP的曲线
            let newPoints = Controller.calculateCurveForVsp(targetVsp);
            Controller.newPQdata = newPoints;
            console.log('Controller.newPQdata,', newPoints);
                
			if (newPoints.length === 0) return;
            
            /* ----------  NEW ---------- *
             * 全局最高效率点，
             */
            Controller.findMaxEfficiencyPoint();
            /* ----------  /NEW ---------- */
            
            let settings = Controller.unitSettings;
            let _pressure_changed = 1;
            let _flow_changed     = 1;
            let _power_changed     = 1;
            let _temp_changed     = 1;
            let flowFactor = _flow_changed ? UnitSettings.conversionFactors.flow[settings.flow] : 1;
            let pressureFactor = _pressure_changed ? UnitSettings.conversionFactors.pressure[settings.pressure] : 1;
            let powerFactor = _power_changed ? UnitSettings.conversionFactors.power[settings.power] : 1;

            // ---- 新增：找出距离 targetVsp 最近的一条旧曲线并隐藏 ----
            var nearest = Controller.visibleVsps.length == 2 ? Controller.visibleVsps[0] : -1;
            if ( nearest == -1 ) {
                //Controller.visibleVsps[0] = targetVsp;
            } else {
                Controller.hideVspSeries(nearest);
                Controller.visibleVsps = [MAXVSP];
            }

            console.log('nearest,', nearest);
            console.log('visibleVsps,', Controller.visibleVsps);
            
			// 准备压力-风量图表数据
			var pressureFlowData = newPoints.map(function(point) {
                let _flow = toFixedValue(point.flow * flowFactor, settings.flow);
                let _pressure = toFixedValue(point.pressure * pressureFactor, settings.pressure);
				return [_flow, _pressure];
			});
			
			// 准备功率-风量图表数据
			var powerData = newPoints.map(function(point) {
                let _flow = toFixedValue(point.flow * flowFactor, settings.flow);
                let _power = toFixedValue(point.power * powerFactor, settings.power);
				return [_flow, _power];
			});
			
			// 准备效率-风量图表数据
			var efficiencyData = newPoints.map(function(point) {
                let _flow = toFixedValue(point.flow * flowFactor, settings.flow);
				return [_flow, point.efficiency];
			});

			// 准备噪音-风量图表数据
			var noiseData = newPoints.map(function(point) {
                let _flow = toFixedValue(point.flow * flowFactor, settings.flow);
				return [_flow, point.noise];
			});

            /* ----------  NEW: 计算新最高效率点并做单位换算 ---------- */
            const mpFlow_m3h = Controller.maxEfficiencyPoint.flow;      // m³/h
            const mpPress_Pa  = Controller.maxEfficiencyPoint.pressure;  // Pa
            const mpPower_W   = Controller.maxEfficiencyPoint.power;     // W
            const mpEff       = Controller.maxEfficiencyPoint.efficiency;
            const mpNoise_dB  = Controller.maxEfficiencyPoint.noise;

            // 按当前单位体系换算并保留同一小数位
            const mpF = toFixedValue(
                UnitSettings.convertValue(mpFlow_m3h, 'm³/h', settings.flow, 'flow'),
                settings.flow
            );
            const mpP = toFixedValue(
                UnitSettings.convertValue(mpPress_Pa, 'Pa', settings.pressure, 'pressure'),
                settings.pressure
            );
            const mpPow = toFixedValue(
                UnitSettings.convertValue(mpPower_W, 'W', settings.power, 'power'),
                settings.power
            );
            /* ----------  /NEW  ---------- */


			// 更新压力-风量图表
			if (Controller.charts.pressureFlow) {
				var option = Controller.charts.pressureFlow.getOption();
				
				// 确保legend和series存在
                option.legend = option.legend || {};
                option.legend.formatter = function (name) {
                    // 只改显示，不改内部匹配用的 name
                    return name.replace(/\s*\(推算\)$/, '');   // 把所有“… (OP)”去掉
                };
				
				if (!option.legend.data) {
					option.legend.data = Controller.visibleVsps.map(function(vsp) { // 20250920
						return vsp + 'V';
					});
				}
				
				if (!option.series || !Array.isArray(option.series)) {
					option.series = [];
				}
				
				// 移除所有现有的推算曲线
				var newSeries = [];
				var newLegendData = [];
				
				// 保留非推算曲线
				for (var i = 0; i < option.series.length; i++) {
					if (option.series[i].name && option.series[i].name.indexOf('(OP)') === -1) {
						newSeries.push(option.series[i]);
						if (option.legend.data && option.legend.data.includes(option.series[i].name)) {
							newLegendData.push(option.series[i].name);
						}
					}
				}
				
				// 更新series和legend.data
				option.series = newSeries;
				option.legend.data = newLegendData;
				
				// 添加新的推算曲线
				option.series.push({
					name: targetVsp.toFixed(1) + 'V (OP)',
					type: 'line',
					data: pressureFlowData,
					smooth: true,
					symbol: 'none',
					symbolSize: 6,
					lineStyle: {
						width: 2,
						color: '#9932CC',  // 使用紫色表示推算曲线
						type: 'dashed'
					},
					itemStyle: {
						color: '#9932CC'
					},
					connectNulls: true,
					z: 2
				});
				
				// 更新图例
				//option.legend.data.push(targetVsp.toFixed(1) + 'V (OP)');
                const legendText = targetVsp.toFixed(1) + 'V (OP)';

                if (Array.isArray(option.legend)) {
                    // getOption 返回数组格式
                    const lg = option.legend[0];
                    if (lg && lg.data && !lg.data.includes(legendText)) {
                        lg.data.push(legendText);        // ★ 这里才是真正生效的位置
                    }
                } else if (option.legend && option.legend.data) {
                    // 初始 setOption 时如果是对象格式
                    if (!option.legend.data.includes(legendText)) {
                        option.legend.data.push(legendText);
                    }
                } else {
                    // 防守：万一之前根本没 legend
                    option.legend = [{ data: [legendText] }];
                }

                /* ----------  最佳效率 ---------- */
                let mpIdx = option.series.findIndex(s => s.name === __('Max Efficiency Point'));
                if (mpIdx !== -1) {
                    option.series[mpIdx].data = [[mpF, mpP]];   // ← 新坐标
                }
                /* ----------  /最佳效率 ---------- */

				// 应用更新的选项
				Controller.charts.pressureFlow.setOption(option);
				
				console.log("已添加推算曲线：" + targetVsp.toFixed(1) + 'V');
				//阻抗
				//Controller.drawImpedanceCurve();

			}
			
			// 更新功率图表
			if (Controller.charts.power) {
				var powerOption = Controller.charts.power.getOption();
				
				// 确保legend和series存在
				if (!powerOption.legend) {
					powerOption.legend = {};
				}
				
				if (!powerOption.legend.data) {
					powerOption.legend.data = Controller.visibleVsps.map(function(vsp) { // 20250920 
						return vsp + 'V';
					});
				}
				
				if (!powerOption.series || !Array.isArray(powerOption.series)) {
					powerOption.series = [];
				}
				
				// 移除所有现有的推算曲线
				var newPowerSeries = [];
				var newPowerLegendData = [];
				
				// 保留非推算曲线
				for (var i = 0; i < powerOption.series.length; i++) {
					if (powerOption.series[i].name && powerOption.series[i].name.indexOf('(OP)') === -1) {
						newPowerSeries.push(powerOption.series[i]);
						if (powerOption.legend.data && powerOption.legend.data.includes(powerOption.series[i].name)) {
							newPowerLegendData.push(powerOption.series[i].name);
						}
					}
				}
				
				// 更新series和legend.data
				powerOption.series = newPowerSeries;
				powerOption.legend.data = newPowerLegendData;
				
				// 添加新的推算曲线
				powerOption.series.push({
					name: targetVsp.toFixed(1) + 'V (OP)',
					type: 'line',
					data: powerData,
					smooth: true,
					symbol: 'none',
					symbolSize: 6,
					lineStyle: {
						width: 2,
						color: '#9932CC',
						type: 'dashed'
					},
					itemStyle: {
						color: '#9932CC'
					},
					connectNulls: true,
					z: 2
				});
				
				// 更新图例
				powerOption.legend.data.push(targetVsp.toFixed(1) + 'V (OP)');

                /* ----------  最佳效率 ---------- */
                mpIdx = powerOption.series.findIndex(s => s.name === __('Max Efficiency Point'));
                if (mpIdx !== -1) {
                    powerOption.series[mpIdx].data = [[mpF, mpPow]];
                }
                /* ----------  /最佳效率 ---------- */

				// 应用更新的选项
				Controller.charts.power.setOption(powerOption);
			}
			
			// 更新效率图表
			if (Controller.charts.efficiency) {
				let effOption = Controller.charts.efficiency.getOption();
				
				// 确保legend和series存在
				if (!effOption.legend) {
					effOption.legend = {};
				}
				
				if (!effOption.legend.data) {
					effOption.legend.data = Controller.visibleVsps.map(function(vsp) { // 20250920
						return vsp + 'V';
					});
				}
				
				if (!effOption.series || !Array.isArray(effOption.series)) {
					effOption.series = [];
				}
				
				// 移除所有现有的推算曲线
				let newEffSeries = [];
				let newEffLegendData = [];
				
				// 保留非推算曲线
				for (let i = 0; i < effOption.series.length; i++) {
					if (effOption.series[i].name && effOption.series[i].name.indexOf('(OP)') === -1) {
						newEffSeries.push(effOption.series[i]);
						if (effOption.legend.data && effOption.legend.data.includes(effOption.series[i].name)) {
							newEffLegendData.push(effOption.series[i].name);
						}
					}
				}
				
				// 更新series和legend.data
				effOption.series = newEffSeries;
				effOption.legend.data = newEffLegendData;
				
				// 添加新的推算曲线
				effOption.series.push({
					name: targetVsp.toFixed(1) + 'V (OP)',
					type: 'line',
					data: efficiencyData,
					smooth: true,
					symbol: 'none',
					symbolSize: 6,
					lineStyle: {
						width: 2,
						color: '#9932CC',
						type: 'dashed'
					},
					itemStyle: {
						color: '#9932CC'
					},
					connectNulls: true,
					z: 2
				});
				
				// 更新图例
				effOption.legend.data.push(targetVsp.toFixed(1) + 'V (OP)');

                /* ----------  最佳效率 ---------- */
                mpIdx = effOption.series.findIndex(s => s.name === __('Max Efficiency Point'));
                if (mpIdx !== -1) {
                    effOption.series[mpIdx].data = [[mpF, mpEff]];
                }
                /* ----------  /最佳效率 ---------- */

				// 应用更新的选项
				Controller.charts.efficiency.setOption(effOption);
			}
            

			// 更新噪音图表
			if (Controller.charts.noise) {
				let noiseOption = Controller.charts.noise.getOption();
				
				// 确保legend和series存在
				if (!noiseOption.legend) {
					noiseOption.legend = {};
				}
				
				if (!noiseOption.legend.data) {
					noiseOption.legend.data = Controller.visibleVsps.map(function(vsp) { // 20250920
						return vsp + 'V';
					});
				}
				
				if (!noiseOption.series || !Array.isArray(noiseOption.series)) {
					noiseOption.series = [];
				}
				
				// 移除所有现有的推算曲线
				let newEffSeries = [];
				let newEffLegendData = [];
				
				// 保留非推算曲线
				for (let i = 0; i < noiseOption.series.length; i++) {
					if (noiseOption.series[i].name && noiseOption.series[i].name.indexOf('(OP)') === -1) {
						newEffSeries.push(noiseOption.series[i]);
						if (noiseOption.legend.data && noiseOption.legend.data.includes(noiseOption.series[i].name)) {
							newEffLegendData.push(noiseOption.series[i].name);
						}
					}
				}
				
				// 更新series和legend.data
				noiseOption.series = newEffSeries;
				noiseOption.legend.data = newEffLegendData;
				
				// 添加新的推算曲线
				noiseOption.series.push({
					name: targetVsp.toFixed(1) + 'V (OP)',
					type: 'line',
					data: noiseData,
					smooth: true,
					symbol: 'none',
					symbolSize: 6,
					lineStyle: {
						width: 2,
						color: '#9932CC',
						type: 'dashed'
					},
					itemStyle: {
						color: '#9932CC'
					},
					connectNulls: true,
					z: 2
				});
				
				// 更新图例
				noiseOption.legend.data.push(targetVsp.toFixed(1) + 'V (OP)');

                /* ----------  最佳效率 ---------- */
                mpIdx = noiseOption.series.findIndex(s => s.name === __('Max Efficiency Point'));
                if (mpIdx !== -1) {
                    noiseOption.series[mpIdx].data = [[mpF, mpNoise_dB]];
                }
                /* ----------  /最佳效率 ---------- */

				// 应用更新的选项
				Controller.charts.noise.setOption(noiseOption);
			}
		},


        // 更新页面上的风机信息
        updateFanInfo: function(data) {
            if (!data) return;
            
            // 更新风机型号、类型等基本信息
            $('.fan-model-title').text(data.fan_model || '');
            $('.fan-type-name').text(data.type_name || '');
            
            // 更新其他详细信息
            $('#fan-diameter').text(data.diameter ? data.diameter + ' mm' : '-');
            $('#fan-motor-power').text(data.motor_power ? data.motor_power + ' W' : '-');
            $('#fan-voltage').text(data.voltage || '-');
            $('#fan-frequency').text(data.frequency ? data.frequency + ' Hz' : '-');
            $('#fan-phase').text(data.phase || '-');
            $('#fan-speed').text(data.speed ? data.speed + ' rpm' : '-');
            $('#fan-current').text(data.current ? data.current + ' A' : '-');
            $('#fan-ip-class').text(data.ip_class || '-');
            $('#fan-insulation-class').text(data.insulation_class || '-');
            $('#fan-temperature-range').text(
                (data.min_operating_temp || '0') + ' ~ ' + 
                (data.max_operating_temp || '0') + ' °C'
            );
            
            // 更新图片
            if (data.image) {
                $('.fan-detail-image').attr('src', '/assets/img/fan/' + data.image);
            }
        },
        
        // 加载PQ数据
        loadPQData: function() {
            var id = Fast.api.query('id');
            if (!id) return;
            
            Fast.api.ajax({
                url: 'fan/getPQData',
                data: {id: id}
            }, function(data) {
                if (data && data.length > 0) {
                    // 处理PQ数据
                    Controller.processPQData(data);
                                        
                    // 初始化图表
                    Controller.initCharts();
                }
                return false;
            });
        },
        
        // 处理PQ数据
        processPQData: function(data) {
            // 按VSP分组
            Controller.pqData = {};
            Controller.availableVsps = [];
            console.log('rawdata', data);
            // 将vsp限制区间添加进去
            MINVSP = vsprange[0];
            MAXVSP = vsprange[1];
            
            // 先收集所有不同的VSP值
            data.forEach(function(item) {
                var vsp = parseFloat(item.vsp || 10);
                if (Controller.availableVsps.indexOf(vsp) === -1) {
                    Controller.availableVsps.push(vsp);
                }
            });
            
            // 按VSP值排序
            Controller.availableVsps.sort(function(a, b) {
                return a - b;
            });

            // 为每个VSP创建一个数组
            Controller.availableVsps.forEach(function(vsp) {
                Controller.pqData[vsp] = [];
            });
                        
            let maxFlow = 0;
            let maxPressure = 0;
            // 将数据点分配到相应的VSP组
            data.forEach(function(item) {
                var vsp = parseFloat(item.vsp || 10);
                
                // 计算效率
                var efficiency = 0;
				if ( item.efficiency > 0 ) {
					efficiency = item.efficiency;
				} else {
					if (parseFloat(item.power) > 0 && parseFloat(item.air_flow_m3h) > 0) {
						efficiency = (parseFloat(item.air_flow_m3h) * parseFloat(item.air_pressure_amend)) / 
									 (parseFloat(item.power) * 3600) * 100;
					}
				}
                // 全压效率
                let fefficiency = (parseFloat(item.air_flow_m3h) * (parseFloat(item.air_pressure_amend)+parseFloat(item.air_pressure_dynamic))) / 
									 (parseFloat(item.power) * 3600) * 100;
                // 创建数据点对象
                var point = {
                    flow: parseFloat(item.air_flow_m3h || 0),
                    pressure: parseFloat(item.air_pressure_amend || 0),
                    power: parseFloat(item.power || 0),
                    current: parseFloat(item.current || 0),
                    speed: parseInt(item.speed || 0),
                    efficiency: parseFloat(efficiency || 0),
                    fefficiency: parseFloat(fefficiency || 0),
                    noise: parseFloat(item.noise || 0),
                    dy_pressure: parseFloat(item.air_pressure_dynamic || 0),
                    vsp: vsp,
                    originalData: item
                };
                
                // 添加到相应的VSP组
                Controller.pqData[vsp].push(point);

            });

        //if ( !is_AC ) {
                       
            function getbaseVsp(target){
                return Controller.availableVsps[Controller.availableVsps.length-1];
                return Controller.availableVsps
                       .filter(v => v > target)        // 只要比它大的
                       .sort((a,b)=>a-b)[0]            // 取最接近的一条
                       || Controller.availableVsps[1]; // 万一没有，再用第二条
            }
            /*
            // 找出推算vsp的basevsp
            let getbaseVsp = (targetVsp) => {
                let baseVsp = Controller.availableVsps[0];
                let minDiff = Math.abs(baseVsp - targetVsp);
                Controller.availableVsps.forEach(v => {
                    let d = Math.abs(v - targetVsp);
                    if (d < minDiff) { minDiff = d; baseVsp = v; }
                });
                //始终不以1.5作为参考
                if (baseVsp == MINVSP) {
                    baseVsp = Controller.availableVsps[1];
                }
                return baseVsp;
            };
            */
            let mvsp3 = getbaseVsp(3);
            let mvsp5 = getbaseVsp(5);
            let mvsp8 = getbaseVsp(8);
            console.log('3,5,8v 推算的基准vsp，,', mvsp3, mvsp5, mvsp8);
            
            // 推算一些常用的vsp数据 2025.07.14
            Controller.opdata3v = Controller.availableVsps.indexOf(3) === -1 ? Controller.calculateCurveForVsp(3,mvsp3) : Controller.pqData[3];
            Controller.opdata5v = Controller.availableVsps.indexOf(5) === -1 ? Controller.calculateCurveForVsp(5,mvsp5) : Controller.pqData[5];
            Controller.opdata8v = Controller.availableVsps.indexOf(8) === -1 ? Controller.calculateCurveForVsp(8,mvsp8) : Controller.pqData[8];
            
            Controller.availableVsps.indexOf(3) === -1 && ('setvsp', Controller.pqData[3] = Controller.opdata3v);
            Controller.availableVsps.indexOf(5) === -1 && ('setvsp', Controller.pqData[5] = Controller.opdata5v);
            Controller.availableVsps.indexOf(8) === -1 && ('setvsp', Controller.pqData[8] = Controller.opdata8v);
            
            
            // 根据风机 speed_control 替换最大vsp 最小vsp
            let _minvsp = getbaseVsp(MINVSP);
            // 重新推算MINVSP
            //if (Controller.availableVsps[0] != MINVSP) {
                let _firstvsp = Controller.availableVsps[0];
                //Controller.pqData[MINVSP] = typeof Controller.pqData[_firstvsp] != 'undefined' ? Controller.pqData[_firstvsp] : Controller.calculateCurveForVsp(MINVSP);
                Controller.pqData[MINVSP] = Controller.calculateCurveForVsp(MINVSP, Controller.availableVsps[1]);
                Controller.availableVsps[0] = MINVSP;
            //}
            
            let _lastindex = Controller.availableVsps.length - 1;
            if (Controller.availableVsps[_lastindex] != MAXVSP) {
                let _lastvsp = Controller.availableVsps[_lastindex];
                Controller.pqData[MAXVSP] = typeof Controller.pqData[_lastvsp] != 'undefined' ? Controller.pqData[_lastvsp] : Controller.calculateCurveForVsp(MAXVSP);
                Controller.availableVsps[_lastindex] = MAXVSP;
            }
            
            // 使用3,5,8填充vsp  -> 20250917
            const needLen   = 3;              // 总长度
            const fillPool  = [3, 5, 8];      // 只允许用这些数来填
            let   vsps      = Controller.availableVsps; 

            const pool = fillPool.filter(v => !vsps.includes(v)).sort((a, b) => a - b);

            while (vsps.length < needLen && pool.length) {
                vsps.sort((a, b) => a - b);

                // ① 找出现有数组里的最大间隔
                let gapIdx = 0, gapSize = -Infinity;
                for (let i = 0; i < vsps.length - 1; i++) {
                    const g = vsps[i + 1] - vsps[i];
                    if (g > gapSize) { gapSize = g; gapIdx = i; }
                }
                const low = vsps[gapIdx], high = vsps[gapIdx + 1];

                // ② 在这个间隔里挑一个最“均匀”的候选值
                let pickIdx = -1, bestScore = Infinity;
                pool.forEach((c, i) => {
                    if (c > low && c < high) {
                        const score = Math.max(c - low, high - c); // 左右两段中较大的那段
                        if (score < bestScore) { bestScore = score; pickIdx = i; }
                    }
                });

                // ③ 取出并放入 vsps
                const chosen = (pickIdx === -1) ? pool.shift() : pool.splice(pickIdx, 1)[0];
                vsps.push(chosen);
            }
            Controller.availableVsps = vsps;
            
            // 按VSP值排序
            Controller.availableVsps.sort(function(a, b) {
                return a - b;
            });
            // 使用3,5,8填充vsp  -> 20250917 end
            // 默认把最小值暂存到隐藏列表
            Controller.hiddenVsps  = [Controller.availableVsps[0]];  // ① 新增
            Controller.visibleVsps = Controller.availableVsps.slice(1); // ② 新增
            
            console.log('Controller.availableVsps,', Controller.availableVsps);
            console.log('Controller.pqData,', Controller.pqData);
            
            //生成一份隐藏vsp曲线
            // ① 构造整数档（dense）
            const dense = [];
            for (let v = Math.ceil(MINVSP); v <= Math.floor(MAXVSP); v += 1) {
                dense.push(v);                     // v 本身就是整数
            }

            // ② 统计 already-covered 的整数档（由 avail 推导）
            const intsCovered = new Set(
                Controller.availableVsps.map(v => Math.floor(v))
            );

            // ③ 过滤掉已覆盖整数，只留下“缺失档”
            const denseFiltered = dense.filter(v => !intsCovered.has(v));

            // ④ 合并：先放精确值，再放补档
            const merged = [...Controller.availableVsps, ...denseFiltered];

            // ⑤ 去重（极端情况下 avail 里本身有 3，也可能与 denseFiltered 重叠）
            //    然后整体升序，方便之后遍历
            Controller.internalVsps = Array.from(new Set(merged)).sort((a, b) => a - b);


            //重新设置pqdata
            for (let _vsp in Controller.pqData) {

                if ( Controller.internalVsps.includes( parseFloat(_vsp) ) ) {
   
                } else {
                    delete Controller.pqData[_vsp];// 删除没保存的vsp， 可能vps只是一个代号
                }
            }
            
            Controller.internalVsps.forEach(v=>{
                let mvsp = getbaseVsp(v);
                if (!Controller.pqData[v]) {
                    Controller.pqData[v] = Controller.calculateCurveForVsp(v,mvsp);
                }
            });
            console.log('Controller.internalVsps,', Controller.internalVsps);
            
        //}
            // 对每个VSP组内的数据按风量排序
            for (var vsp in Controller.pqData) {
                if (Controller.pqData.hasOwnProperty(vsp)) {  
                    // 不在这里排序，等待点击的时候排序
                    //Controller.pqData[vsp].sort(function(a, b) {
                    //    return a.flow - b.flow;
                    //});
                    let _vsp = parseFloat(vsp);
                    if ( Controller.availableVsps.includes(_vsp) ) {
                        Controller.pqData[vsp].forEach(function(item) {
                                maxFlow = Math.max(parseFloat(item.flow || 0), maxFlow);
                                maxPressure = Math.max(parseFloat(item.pressure || 0), maxPressure);
                        });  
                    }    
                }
            }
            Controller.MAXFLOW = maxFlow;
            Controller.MAXPRESSURE = maxPressure;
            console.log('Controller.pqData2', Controller.pqData);

            // 查找最高效率点
            Controller.findMaxEfficiencyPoint();
            
            // 设置默认操作点
            Controller.findoperatingPoint();
            
            console.log('---init finished---');
        
        },
        
        // 查找默认操作点
        findoperatingPoint: function () {
                    
            // 设置默认操作点 (选择第一个VSP的中间点)
            if (Controller.availableVsps.length > 0) {
                var firstVsp = Controller.availableVsps[ Controller.availableVsps.length > 2 ? 2 : 1];
                var points = Controller.pqData[firstVsp];
                
                if (points && points.length > 0) {
                    var middleIndex = Math.floor(points.length / 2);
                    var middlePoint = points[middleIndex];
                    
                    // 确保选择的点有效
                    if (middlePoint.flow > 0) {
                        Controller.operatingPoint = {
                            flow: middlePoint.flow,
                            pressure: middlePoint.pressure,
                            power: middlePoint.power,
                            current: middlePoint.current,
                            speed: middlePoint.speed,
                            efficiency: middlePoint.efficiency,
                            fefficiency: middlePoint.fefficiency,
                            dy_pressure: middlePoint.dy_pressure,
                            noise: middlePoint.noise,
                            temperature: 20,
                            vsp: middlePoint.vsp
                        };

						// 更新操作点表格
						//Controller.updateOperatingPointTable();
                    } else {
                        // 如果中间点无效，选择第一个有效点
                        for (var i = 0; i < points.length; i++) {
                            if (points[i].flow > 0) {
                                Controller.operatingPoint = {
                                    flow: points[i].flow,
                                    pressure: points[i].pressure,
                                    power: points[i].power,
                                    current: points[i].current,
                                    speed: points[i].speed,
                                    efficiency: points[i].efficiency,
                                    fefficiency: points[i].fefficiency,
                                    noise: points[i].noise,
                                    dy_pressure: points[i].dy_pressure,
                                    temperature: 20,
                                    vsp: points[i].vsp
                                };
								// 更新操作点表格
								//Controller.updateOperatingPointTable();
                                break;
                            }
                        }
                    }
                }
            }
            
            
        },
        
        // 查找最高效率点
        findMaxEfficiencyPoint: function() {
            var maxEff = -1;
            var maxPoint = null;
            var points = false;
            
            // 在所有点中查找最高效率点
            var vsp = Controller.visibleVsps[Controller.visibleVsps.length-1];

                points = Controller.pqData[vsp];    
                points && points.forEach(function(point) {
                    if (point.efficiency > maxEff) {
                        maxEff = point.efficiency;
                        maxPoint = point;
                    }
                });                        
            
    
            if (maxPoint) {
                Controller.maxEfficiencyPoint = maxPoint;
            }
        },
                
        // 初始化图表
        initCharts: function() {
            
            // 初始化压力-风量图表
            Controller.initPressureFlowChart();
            
            // 初始化功率-风量图表
            Controller.initPowerChart();
            
            // 初始化效率-风量图表
            Controller.initEfficiencyChart();

            // 初始化噪音-风量图表
            Controller.initNoiseChart();
            
            // 更新操作点表格
            Controller.updateOperatingPointTable();
            
            // 调整图表大小
            Controller.resizeCharts();
        },
        
        // 初始化压力-风量图表
        initPressureFlowChart: function() {
            var chartDom = document.getElementById('pressure-flow-chart');
            if (!chartDom) return;
            
            // ① 当前单位（全部转成小写，便于匹配 conversionFactors）
            const flowUnit     = Controller.unitSettings.flow;      // cfm / m³/h …
            const pressureUnit = Controller.unitSettings.pressure;  // kpa / pa …
            
            // 创建图表实例
            //Controller.charts.pressureFlow = echarts.init(chartDom);
            Controller.charts.pressureFlow = echarts.init(chartDom, null, { renderer: 'canvas' });
            
            // 准备数据系列
            var series = [];
            var colors = ['#ff0000', '#0000ff', '#00aa00', '#ff00ff', '#ffaa00', '#00ffff'];
            var maxFlow = 0;
            var maxPressure = 0;

            // 为每个VSP创建一个系列
            Controller.visibleVsps.forEach(function(vsp, index) { // 20250920
                var points = Controller.pqData[vsp];
                var color = colors[index % colors.length];
                
                // 准备系列数据
                var seriesData = points.map(function(point) {
                    
                    let _flow = UnitSettings.convertValue(point.flow,     'm³/h', flowUnit,     'flow');
                    let _press = UnitSettings.convertValue(point.pressure, 'Pa',   pressureUnit, 'pressure');
            
                    // 更新最大值
                    maxFlow = Math.max(maxFlow, _flow);
                    maxPressure = Math.max(maxPressure, _press);
                    
                    return [_flow, _press];
                });
                
                // 添加系列
                series.push({
                    name: vsp + 'V',
                    type: 'line',
                    data: seriesData,
                    smooth: true,
                    symbol: 'none',
                    symbolSize: 6,
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
            
            // 添加操作点标记
            if (Controller.operatingPoint && Controller.operatingPoint.flow > 0) {
                let opF = UnitSettings.convertValue(Controller.operatingPoint.flow,     'm³/h', flowUnit,     'flow');
                let opP = UnitSettings.convertValue(Controller.operatingPoint.pressure, 'Pa',   pressureUnit, 'pressure');
                /*
                series.push({
                    name: __('Operating Point'),
                    type: 'scatter',
                    data: [[opF, opP]],
                    symbol: 'pin',
                    symbolSize: 15,
                    itemStyle: {
                        color: '#ff4500'
                    },
                    label: {
                        show: true,
                        position: 'top',
                        formatter: Controller.operatingPoint.vsp, //OP
                        color: '#ff4500'
                    },
                    z: 10
                });*/
            }
            
            // 添加最高效率点标记
            if (Controller.maxEfficiencyPoint && Controller.maxEfficiencyPoint.flow > 0) {
                let mpF = UnitSettings.convertValue(Controller.maxEfficiencyPoint.flow,     'm³/h', flowUnit,     'flow');
                let mpP = UnitSettings.convertValue(Controller.maxEfficiencyPoint.pressure, 'Pa',   pressureUnit, 'pressure');
                
                series.push({
                    name: __('Max Efficiency Point'),
                    type: 'scatter',
                    data: [[mpF, mpP]],
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
            
            // 设置图表选项
            var option = {
                title: {
                    text: __('Pressure - Flow Curve'),
                    left: 'center'
                },

                 tooltip: {
                    trigger: 'axis',        // 按轴触发
                    triggerOn: 'mousemove', // 鼠标移动时触发，也可以加 'click'
                    axisPointer: {
                      type: 'cross',        // 十字交叉线
                      snap: false,          // 关键：不再吸附到最近数据点
                      lineStyle: {          // 可以自定义线条样式
                        color: '#999',
                        width: 1,
                        type: 'dashed'
                      }
                    },
                    // 如果你不想显示默认的 tooltip 框：
                    showContent: false
                },
                legend: {
                    show: false,
                    data: Controller.visibleVsps.map(function(vsp) { // 20250920
                        return vsp + 'V';
                    }),
                    orient    : 'vertical',  // 垂直排成一列
                    right     : 1,           // 紧贴右侧
                    top       : 30,          // 离顶部 20 px
                    itemGap   : 8,           // 项之间的距离
                    align     : 'left'       // 文本在标记右边
                },
                grid: {
                    left: 30,
                    right: 20,
                    bottom: '10%',
                    top: 60,
                    containLabel: true
                },
                xAxis: {
                    type: 'value',
                    ...verticalName('Flow (' + Controller.unitSettings.flow + ')', 0, 35),
                    min: 0,
                    max: +(Controller.MAXFLOW * 1.1).toFixed(3),
                    axisPointer: {
                      show: true,
                      snap: false
                    }
                },
                yAxis: {
                    type: 'value',
                    ...verticalName('Pressure (' + Controller.unitSettings.pressure + ')', 90),
                    //name: __('Pressure') + ' (' + Controller.unitSettings.pressure + ')',
                    min: 0,
                    max: +(maxPressure * 1.1).toFixed(3),
                    axisPointer: {
                      show: true,
                      snap: false
                    }
                },
                series: series
            };
            
            // 设置图表配置
            Controller.charts.pressureFlow.setOption(option);
            //添加阻抗
            Controller.drawImpedanceCurve(Controller.maxEfficiencyPoint); 
            initZK = false;//初始化只加载一次阻抗曲线

			// 添加图表点击事件处理 AC风机不需要
			if ( !is_AC ) {

				// 获取ZRender实例（ECharts的渲染器）
				var zr = Controller.charts.pressureFlow.getZr();

				// 添加ZRender点击事件（可以捕获空白区域点击）
				zr.on('click', function(event) {

					//if (event.target) {
					//  已经被series的click事件处理，不需要再处理
					//	return;
					//}
					
					// 获取点击位置的像素坐标
					var pointInPixel = [event.offsetX, event.offsetY];
					
					// 获取坐标系组件
					var grid = Controller.charts.pressureFlow.getModel().getComponent('grid');
					var xAxis = Controller.charts.pressureFlow.getModel().getComponent('xAxis', 0);
					var yAxis = Controller.charts.pressureFlow.getModel().getComponent('yAxis', 0);
					
					// 获取坐标系
					var coordSys = grid.coordinateSystem;
					console.log(coordSys);
					
					// 获取网格的位置和大小
					var rect = coordSys._rect;
					console.log(rect);
					
					// 检查点击是否在网格内
					if (
						pointInPixel[0] < rect.x || 
						pointInPixel[0] > rect.x + rect.width || 
						pointInPixel[1] < rect.y || 
						pointInPixel[1] > rect.y + rect.height
					) {
						// 点击在网格外，不处理
						return;
					}
					
					// 计算点击位置在网格中的相对位置（0-1之间）
					var xPercent = (pointInPixel[0] - rect.x) / rect.width;
					var yPercent = (pointInPixel[1] - rect.y) / rect.height;
					
					// 获取坐标轴的数据范围
					var xMin = xAxis.axis.scale.getExtent()[0];
					var xMax = xAxis.axis.scale.getExtent()[1];
					var yMin = yAxis.axis.scale.getExtent()[0];
					var yMax = yAxis.axis.scale.getExtent()[1];
					
					// 将相对位置转换为数据值（注意Y轴是反向的）
					var flow = xMin + xPercent * (xMax - xMin);
					var pressure = yMax - yPercent * (yMax - yMin);
					
					// 确保值在有效范围内
					flow = Math.max(xMin, Math.min(xMax, flow));
					pressure = Math.max(yMin, Math.min(yMax, pressure));

					console.log("点击位置对应的数据值：", flow, pressure);
					
                    $('#set-flow').val( toFixedValue(flow, Controller.unitSettings.flow) );
                    $('#set-pressure').val( toFixedValue(pressure, Controller.unitSettings.pressure) );
                  
					Controller.calculateOperatingPoint();
					return false;

				});

			}
			
        },

       // 更新操作点数据 2025.04.26
        updateOperatingPoint: function(point, tempFactor) {
            if (!point) return;
            
            // 转换单位
            $('#op-flow').text(Controller.convertValue(
                point.air_flow_m3h, 
                'm³/h', 
                Controller.unitSettings.flow, 
                'flow'
            ).toFixed(0));
            
            $('#op-static-pressure').text(Controller.convertValue(
                point.air_pressure, 
                'Pa', 
                Controller.unitSettings.pressure, 
                'pressure'
            ).toFixed(0));
            
            // 计算总压力 = 静压 + 动压
            var totalPressure = parseFloat(point.air_pressure) + parseFloat(point.air_pressure_amend || 0);
            $('#op-total-pressure').text(Controller.convertValue(
                totalPressure, 
                'Pa', 
                Controller.unitSettings.pressure, 
                'pressure'
            ).toFixed(0));
            
            $('#op-dynamic-pressure').text(Controller.convertValue(
                point.air_pressure_amend || 0, 
                'Pa', 
                Controller.unitSettings.pressure, 
                'pressure'
            ).toFixed(0));
            
            // 计算风速 (m/s)
            var speed = point.air_flow_m3h / 3600; // 转换为 m³/s
            if (Controller.fanInfo.impeller_diameter) {
                var area = Math.PI * Math.pow(Controller.fanInfo.impeller_diameter / 1000 / 2, 2); // 面积，单位m²
                speed = speed / area;
            }
            $('#op-speed').text(speed.toFixed(0));
            
            // 应用温度修正系数
            var correctedSpeed = point.speed * Math.sqrt(tempFactor);
            $('#op-rpm').text(correctedSpeed.toFixed(0));
            
            var correctedPower = point.power * tempFactor;
            $('#op-power').text(Controller.convertValue(
                correctedPower, 
                'W', 
                Controller.unitSettings.power, 
                'power'
            ).toFixed(0));
            
            var correctedCurrent = point.current * Math.sqrt(tempFactor);
            $('#op-current').text(correctedCurrent.toFixed(0));
            
            // 计算SFP
            var sfp = correctedPower / (point.air_flow_m3h / 3600);
            $('#op-sfp').text(sfp.toFixed(2));
            
            // 效率
            $('#op-static-efficiency').text((point.efficiency || 0).toFixed(0));
            
            // 计算总效率
            var totalEfficiency = point.efficiency * (totalPressure / point.air_pressure);
            $('#op-total-efficiency').text(totalEfficiency.toFixed(0));
        },

		// 查找曲线上最接近给定点的点 2025.04.26
		findNearestPointOnCurve: function(flow, pressure, curvePoints) {
			var minDistance = Infinity;
			var nearestPoint = null;
			
			for (var i = 0; i < curvePoints.length; i++) {
				var point = curvePoints[i];
				var distance = Math.sqrt(
					Math.pow(flow - point.flow, 2) + 
					Math.pow(pressure - point.pressure, 2)
				);
				
				if (distance < minDistance) {
					minDistance = distance;
					nearestPoint = point;
				}
			}
			
			return nearestPoint;
		},

		// 设置操作点
		setOperatingPoint: function(flow, pressure, targetVsp) {
            
            // ② 用二维距离在刚生成的曲线上找最近点 20250820
            //var nearest = Controller.findNearestPointOnCurve(flow, pressure, Controller.newPQdata);

            // ③ 如果没找到（极端情况），再退回 getValidOperatingPoint()

			// 检查点击位置是否在有效的VSP曲线范围内
            // 仅用于包络校正，最终 VSP 由 interpolateVsp 决定
			var validPoint = Controller.getValidOperatingPoint(flow, pressure);
			
			// 使用有效的操作点
			Controller.operatingPoint = {
				flow: validPoint.flow,
				pressure: validPoint.pressure,
				temperature: Controller.operatingPoint.temperature || 20,
				vsp: targetVsp,
                // 初始化其他参数，等待计算
                power: 0,
                current: 0,
                speed: 0,
                noise: 0,
                efficiency: 0,
                fefficiency: 0,
                dy_pressure: 0,
			};
			
			// 计算操作点的相关参数 
			Controller.calculateOperatingPointParameters(targetVsp);
			
			// 更新操作点表格
			Controller.updateOperatingPointTable();
			
			// 更新图表上的操作点
			Controller.updateChartOperatingPoint();
		},

		// 获取有效的操作点（确保在VSP曲线范围内）
		getValidOperatingPoint: function(flow, pressure) {
			// 获取所有可用的VSP值
			//var vsps = Object.keys(Controller.pqData).map(function(vsp) {
			//	return parseFloat(vsp);
			//}).sort(function(a, b) {
			//	return a - b;
			//});
            var vsps = Controller.internalVsps;//Controller.availableVsps;
            
            if (flow > Controller.MAXFLOW) {
                flow = Controller.MAXFLOW;   // 不夹断压力，只把 Q 限死在已有最大
            }

			if (vsps.length === 0) {
				// 如果没有可用的VSP曲线，直接返回原始点
				return {flow: flow, pressure: pressure, vsp: MAXVSP};
			}
			
			// 找出最小和最大VSP值
			var minVsp = vsps[0];
			var maxVsp = vsps[vsps.length - 1];
			
			// 对于给定的流量，计算最小和最大VSP曲线上的压力
			var minPressure = Controller.getPressureOnVspCurve(flow, minVsp);
			var maxPressure = Controller.getPressureOnVspCurve(flow, maxVsp);
			
			// 如果无法计算压力范围，直接返回原始点
			if (minPressure === null || maxPressure === null) {
				return {flow: flow, pressure: pressure, vsp: MAXVSP};
			}
			
			// 确保最小压力小于最大压力（VSP值越大，压力越高）
			if (minPressure > maxPressure) {
				var temp = minPressure;
				minPressure = maxPressure;
				maxPressure = temp;
			}
			
			// 检查压力是否在有效范围内
			if (pressure < minPressure) {
				// 如果压力小于最小VSP曲线上的压力，取最小VSP曲线上的点
				return {
					flow: flow,
					pressure: minPressure,
					vsp: minVsp
				};
			} else if (pressure > maxPressure) {
				// 如果压力大于最大VSP曲线上的压力，取最大VSP曲线上的点
				return {
					flow: flow,
					pressure: maxPressure,
					vsp: maxVsp
				};
			} else {
				// 如果压力在有效范围内，计算对应的VSP值
				var vsp = Controller.getinterpolateVsp(flow, pressure, vsps);
				return {
					flow: flow,
					pressure: pressure,
					vsp: vsp
				};
			}
		},
        
        // 在 VSP 曲线上获取给定压力对应的流量（支持末段外推）20250829
        getFlowOnVspCurve: function (pressure, vsp) {
            const curve = Controller.pqData[vsp];
            if (!curve || curve.length === 0) return null;

            const n = curve.length - 1;

            // ★ 先处理两侧外插
            if (pressure >= curve[0].pressure) {          // 位于最左端（高压端）
                return curve[0].flow;
            }
            if (pressure <= curve[n].pressure) {          // 位于最右端（低压端），做线性外推
                const p1 = curve[n - 1], p2 = curve[n];
                const k  = (p2.flow - p1.flow) / (p2.pressure - p1.pressure);
                return p2.flow + k * (pressure - p2.pressure);
            }

            // ★ 位于曲线内部 —— 找到跨越区间做线性插值
            for (let i = 0; i < n; i++) {
                const p1 = curve[i], p2 = curve[i + 1];
                if ((pressure <= p1.pressure && pressure >= p2.pressure) ||
                    (pressure >= p1.pressure && pressure <= p2.pressure)) {

                    const t = (pressure - p1.pressure) / (p2.pressure - p1.pressure);
                    return p1.flow + t * (p2.flow - p1.flow);
                }
            }
            return null;    // 理论到不了
        },

		// 在VSP曲线上获取给定流量对应的压力
        /*
		getPressureOnVspCurve: function(flow, vsp) {
			var curvePoints = Controller.pqData[vsp];
			if (!curvePoints || curvePoints.length === 0) {
				return null;
			}
			
			// 按流量排序
			curvePoints.sort(function(a, b) {
				return a.flow - b.flow;
			});
			
			// 检查流量是否在曲线范围内
			var minFlow = curvePoints[0].flow;
			var maxFlow = curvePoints[curvePoints.length - 1].flow;
			
			if (flow < minFlow) {
				// 如果流量小于曲线最小流量，返回曲线起点的压力
				return curvePoints[0].pressure;
			} else if (flow > maxFlow) {
				// 如果流量大于曲线最大流量，返回曲线终点的压力
				return curvePoints[curvePoints.length - 1].pressure;
			} else {
				// 在曲线上进行线性插值
				for (var i = 0; i < curvePoints.length - 1; i++) {
					var p1 = curvePoints[i];
					var p2 = curvePoints[i + 1];
					
					if (flow >= p1.flow && flow <= p2.flow) {
						// 线性插值计算压力
						var ratio = (flow - p1.flow) / (p2.flow - p1.flow);
						return p1.pressure + ratio * (p2.pressure - p1.pressure);
					}
				}
			}
			
			// 如果无法插值（理论上不应该发生），返回null
			return null;
		},
        */

        // 在 VSP 曲线上获取给定流量对应的压力（不排序）
        getPressureOnVspCurve: function(flow, vsp) {
            const curvePoints = Controller.pqData[vsp];
            if (!curvePoints || !curvePoints.length) return null;
            return pressureOnCurve(flow, curvePoints);
        },

        solveVsp2D: function(flow, pressure){
            const vsps = Controller.internalVsps;                    // 升序
            let prev  = null;                                        // {V,P}

            for (const V of vsps){
                const P = Controller.getPressureOnVspCurve(flow, V); // 一维插值
                if (P === null) continue;                            // 超出曲线

                if (P >= pressure){                                  // 找到跨越点
                    if (!prev) return V;                             // 只有一条能用
                    const t = (pressure - prev.P) / (P - prev.P);    // 线性权重
                    return +(prev.V + t * (V - prev.V)).toFixed(2);  // 保留 2 位
                }
                prev = {V,P};
            }
            return vsps[vsps.length-1];                              // 低压极限外推
        },

		// 根据流量和压力插值计算VSP值
		getinterpolateVsp: function(flow, pressure, vsps) {
			// 如果只有一个VSP值，直接返回
			if (vsps.length === 1) {
				return vsps[0];
			}
			
			// 找出压力所在的VSP区间
			var lowerVsp = null;
			var upperVsp = null;
			var lowerPressure = null;
			var upperPressure = null;
			
			// 计算每个VSP值对应的压力
			for (var i = 0; i < vsps.length; i++) {
				var vsp = vsps[i];
				var curPressure = Controller.getPressureOnVspCurve(flow, vsp);
				
				if (curPressure === null) continue;
				
				if (curPressure <= pressure && (lowerPressure === null || curPressure > lowerPressure)) {
					lowerVsp = vsp;
					lowerPressure = curPressure;
				}
				
				if (curPressure >= pressure && (upperPressure === null || curPressure < upperPressure)) {
					upperVsp = vsp;
					upperPressure = curPressure;
				}
			}
			
			// 如果找不到完整区间，使用最接近的VSP值
			if (lowerVsp === null) {
				return upperVsp;
			} else if (upperVsp === null) {
				return lowerVsp;
			}
			
			// 线性插值计算VSP值
			var ratio = (pressure - lowerPressure) / (upperPressure - lowerPressure);
			return lowerVsp + ratio * (upperVsp - lowerVsp);
		},

		// 计算操作点的相关参数
		calculateOperatingPointParameters: function(targetVsp) {
            const op = Controller.operatingPoint;
            const proj = Controller.projectionData;
        
            // 基础密度计算
            const temperature = op.temperature || 20;
            op.density = 1.293 * (273.15 / (273.15 + temperature)) * (101325 / 101325);
        
            // 检查是否有用于推算的投影数据
            if (proj && proj.baseVsp && proj.speedRatio) {
                const baseCurve = Controller.pqData[proj.baseVsp];
                const k = proj.speedRatio;
                
                if (baseCurve && baseCurve.length > 0) {
                    // 1. 找到在基准曲线上的同源点
                    const baseFlow = op.flow / k;
                    
                    // 2. 在基准曲线上插值该点的所有参数
                    const pt_base = Controller.interpolatePoint(baseFlow, baseCurve);
                    
                    if (pt_base) {
                        //op.flow      = pt_base.flow - 0;
                        //op.pressure      = pt_base.pressure - 0;
                        // 3. 应用风机定律从插值的基准点计算最终的操作点参数
                        op.power = pt_base.power * Math.pow(k, 2.998); // 使用与calculateCurveForVsp中相同的功率定律
                        op.speed = pt_base.speed * k;
                        op.noise = (pt_base.noise - 0) + 30 * Math.log10(k);
                        op.dy_pressure = pt_base.dy_pressure - 0;
                        
                        // 效率理论上应与基准点相同，这比从可能不一致的P,Q,W重新计算更可靠
                        op.efficiency = toFixedValue((pt_base.flow * pt_base.pressure)/(pt_base.power * 3600) * 100, '', 2) - 0;
                        op.fefficiency      = toFixedValue((pt_base.flow * (pt_base.pressure+pt_base.dy_pressure))/(pt_base.power * 3600) * 100, '', 2) - 0;
                        //op.efficiency = pt_base.efficiency;
                        //op.fefficiency = pt_base.fefficiency;
                    }
                }
            } else {
                // 如果没有投影数据（例如，点在现有曲线上），则回退到旧逻辑
                const curveData = Controller.newPQdata.length > 0 ? Controller.newPQdata : Controller.pqData[targetVsp];
                if (curveData && curveData.length > 0) {
                    const pt = Controller.interpolatePoint(op.flow, curveData);
                    if (pt) {
                        op.power = pt.power;
                        op.speed = pt.speed;
                        op.noise = pt.noise;
                        op.dy_pressure = pt.dy_pressure;
                        //op.efficiency = pt.efficiency;
                        //op.fefficiency = pt.fefficiency;
                        op.efficiency = toFixedValue((pt.flow * pt.pressure)/(pt.power * 3600) * 100, '', 2) - 0;
                        op.fefficiency      = toFixedValue((pt.flow * (pt.pressure+pt.dy_pressure))/(pt.power * 3600) * 100, '', 2) - 0;
                    }
                }
            }
            
            op.vsp = targetVsp;

            console.log("操作点参数已计算:", op);
        },
        
        // 按flow排序版本，暂时不用
        interpolatePoint2: function (flow, curve) {
            // curve 已按 flow 升序
            const n = curve.length;
            if (n === 0) return null;

            if (flow <= curve[0].flow)  return curve[0];           // 左外侧
            if (flow >= curve[n - 1].flow) return curve[n - 1];    // 右外侧

            // 找到左右区间
            for (let i = 0; i < n - 1; i++) {
                const p1 = curve[i], p2 = curve[i + 1];
                if (flow >= p1.flow && flow <= p2.flow) {
                    const t = (flow - p1.flow) / (p2.flow - p1.flow);

                    // 对每个字段做线性插值
                    const lerp = (a, b) => a + t * (b - a);
                    return {
                        flow,
                        pressure  : lerp(p1.pressure,   p2.pressure),
                        dy_pressure  : lerp(p1.dy_pressure,   p2.dy_pressure),
                        power     : lerp(p1.power,      p2.power),
                        efficiency: lerp(p1.efficiency, p2.efficiency),
                        fefficiency: lerp(p1.fefficiency, p2.fefficiency),
                        speed     : lerp(p1.speed,      p2.speed),
                        noise     : lerp(p1.noise ?? 0, p2.noise ?? 0),
                        vsp       : p1.vsp              // 两点同一条曲线，直接沿用
                    };
                }
            }
            return null; 
        },
        // 无排序版本        
        interpolatePoint1: function (flow, curve) {
            const n = curve.length;
            if (n === 0) return null;
            if (n === 1) return curve[0];

            let bestSeg = null,  bestT = 1e9;     // t 越靠近 0.5 代表越“居中”

            // 1. 找所有“跨越目标 flow 的线段”
            for (let i = 0; i < n - 1; i++) {
                const p1 = curve[i], p2 = curve[i + 1];
                const minx = Math.min(p1.flow, p2.flow);
                const maxx = Math.max(p1.flow, p2.flow);
                if (flow >= minx && flow <= maxx) {
                    const t = (flow - p1.flow) / (p2.flow - p1.flow);   // t ∈ [0,1] 可能为负
                    const distToMid = Math.abs(t - 0.5);                // 越小越“中间”
                    if (distToMid < bestT) {
                        bestT = distToMid;
                        bestSeg = {p1, p2, t};
                    }
                }
            }

            // 2. 如果找到跨越段就按线性插值；否则做外推
            const seg = bestSeg ??
                        (flow < Math.min(...curve.map(p => p.flow))  ? {p1: curve[0],      p2: curve[1],      t: 0}
                                                                     : {p1: curve[n - 2], p2: curve[n - 1], t: 1});

            const lerp = (a, b) => a + seg.t * (b - a);
            return {
                flow,
                pressure   : lerp(seg.p1.pressure,    seg.p2.pressure),
                dy_pressure: lerp(seg.p1.dy_pressure, seg.p2.dy_pressure),
                power      : lerp(seg.p1.power,       seg.p2.power),
                efficiency : lerp(seg.p1.efficiency,  seg.p2.efficiency),
                fefficiency: lerp(seg.p1.fefficiency, seg.p2.fefficiency),
                speed      : lerp(seg.p1.speed,       seg.p2.speed),
                noise      : lerp(seg.p1.noise ?? 0,  seg.p2.noise ?? 0),
                vsp        : seg.p1.vsp
            };
        },

        // 临时按flow排序
        interpolatePoint: function (flow, curve) {

            /* 第一次调用时给这条曲线生成一份按 flow 升序的 **缓存**，
               以后再调用直接复用，不会改变 curve 本身的原始顺序 */
            if (!curve._sortedByFlow) {
                curve._sortedByFlow = curve.slice().sort((a, b) => a.flow - b.flow);
            }
            const pts = curve._sortedByFlow;      // 下面保持你原来的逻辑
            const n = pts.length;
            if (n === 0) return null;

            if (flow <=  pts[0].flow)     return pts[0];       // 左外侧外推
            if (flow >= pts[n - 1].flow)  return pts[n - 1];   // 右外侧外推

            for (let i = 0; i < n - 1; i++) {
                const p1 = pts[i], p2 = pts[i + 1];
                if (flow >= p1.flow && flow <= p2.flow) {
                    const t   = (flow - p1.flow) / (p2.flow - p1.flow);
                    const lerp = (a, b) => a + t * (b - a);
                    return {
                        flow,
                        pressure   : lerp(p1.pressure,    p2.pressure),
                        dy_pressure: lerp(p1.dy_pressure, p2.dy_pressure),
                        power      : lerp(p1.power,       p2.power),
                        efficiency : lerp(p1.efficiency,  p2.efficiency),
                        fefficiency: lerp(p1.fefficiency, p2.fefficiency),
                        speed      : lerp(p1.speed,       p2.speed),
                        noise      : lerp(p1.noise ?? 0,  p2.noise ?? 0),
                        vsp        : p1.vsp
                    };
                }
            }
            return null;         
        },


        // 初始化功率-风量图表
        initPowerChart: function() {
            var chartDom = document.getElementById('power-chart');
            if (!chartDom) return;
            
            // 创建图表实例
             Controller.charts.power = echarts.init(chartDom, null, { renderer: 'canvas' });
            
            // 准备数据系列
            var series = [];
            var colors = ['#ff0000', '#0000ff', '#00aa00', '#ff00ff', '#ffaa00', '#00ffff'];
            var maxFlow = 0;
            var maxPower = 0;
            
            // 为每个VSP创建一个系列
            Controller.visibleVsps.forEach(function(vsp, index) { // 20250920
                var points = Controller.pqData[vsp];
                var color = colors[index % colors.length];
                
                // 准备系列数据
                var seriesData = points.map(function(point) {
                    // 更新最大值
                    maxFlow = Math.max(maxFlow, point.flow);
                    maxPower = Math.max(maxPower, point.power);
                    
                    return [point.flow, point.power];
                });
                
                // 添加系列
                series.push({
                    name: vsp + 'V',
                    type: 'line',
                    data: seriesData,
                    smooth: true,
                    symbol: 'none',
                    symbolSize: 6,
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
            
            // 添加操作点标记
            /*if (Controller.operatingPoint && Controller.operatingPoint.flow > 0) {
                series.push({
                    name: __('Operating Point'),
                    type: 'scatter',
                    data: [[Controller.operatingPoint.flow, Controller.operatingPoint.power]],
                    symbol: 'pin',
                    symbolSize: 15,
                    itemStyle: {
                        color: '#ff4500'
                    },
                    z: 10
                });
            }*/
            
            // 添加最高效率点标记
            if (Controller.maxEfficiencyPoint && Controller.maxEfficiencyPoint.flow > 0) {
                series.push({
                    name: __('Max Efficiency Point'),
                    type: 'scatter',
                    data: [[Controller.maxEfficiencyPoint.flow, Controller.maxEfficiencyPoint.power]],
                    symbol: 'diamond',
                    symbolSize: 12,
                    itemStyle: {
                        color: '#00cc00'
                    },
                    z: 9
                });
            }
            
            // 设置图表选项
            var option = {
                title: {
                    text: __('Power - Flow Curve'),
                    left: '33%',
                    x: 'center',
                    top: 10,             // 离容器顶部 10px
                    padding: [0, 0, 10, 0], // 底部再空 10px
                },

                 tooltip: {
                    trigger: 'axis',        // 按轴触发
                    triggerOn: 'mousemove', // 鼠标移动时触发，也可以加 'click'
                    axisPointer: {
                      type: 'cross',        // 十字交叉线
                      snap: false,          // 关键：不再吸附到最近数据点
                      lineStyle: {          // 可以自定义线条样式
                        color: '#999',
                        width: 1,
                        type: 'dashed'
                      }
                    },
                    // 如果你不想显示默认的 tooltip 框：
                    showContent: false
                },
                legend: {
                    show: false
                    //data: Controller.availableVsps.map(function(vsp) {
                    //    return vsp + 'V';
                    //}),
                    //bottom: 0
                },
                grid: {
                    left: 30,
                    right: 15,
                    bottom: '10%',
                    top: 60,
                    containLabel: true
                },
                xAxis: {
                    type: 'value',
                    ...verticalName('Flow (' + Controller.unitSettings.flow + ')', 0, 35),
                    min: 0,
                    max: +(Controller.MAXFLOW * 1.1).toFixed(3),
                    axisPointer: {
                      show: true,
                      snap: false
                    }
                    
                },
                yAxis: {
                    type: 'value',
                    ...verticalName('Power (' + Controller.unitSettings.power + ')', 90),
                    min: 0,
                    max: +(maxPower * 1.1).toFixed(3),
                    axisPointer: {
                      show: true,
                      snap: false
                    }
                },
                series: series
            };
            
            // 设置图表配置
            Controller.charts.power.setOption(option);
        },
        
        // 初始化效率-风量图表
        initEfficiencyChart: function() {
            var chartDom = document.getElementById('efficiency-chart');
            if (!chartDom) return;
            
            // 创建图表实例
            Controller.charts.efficiency = echarts.init(chartDom, null, { renderer: 'canvas' });

            
            // 准备数据系列
            var series = [];
            var colors = ['#ff0000', '#0000ff', '#00aa00', '#ff00ff', '#ffaa00', '#00ffff'];
            var maxFlow = 0;
            var maxEfficiency = 0;
            
            // 为每个VSP创建一个系列
            Controller.visibleVsps.forEach(function(vsp, index) { // 20250920
                var points = Controller.pqData[vsp];
                var color = colors[index % colors.length];
                
                // 准备系列数据
                var seriesData = points.map(function(point) {
                    // 更新最大值
                    maxFlow = Math.max(maxFlow, point.flow);
                    maxEfficiency = Math.max(maxEfficiency, point.efficiency);
                    
                    return [point.flow, point.efficiency];
                });
                
                // 添加系列
                series.push({
                    name: vsp + 'V',
                    type: 'line',
                    data: seriesData,
                    smooth: true,
                    symbol: 'none',
                    symbolSize: 6,
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
            
            // 添加操作点标记
            /*if (Controller.operatingPoint && Controller.operatingPoint.flow > 0) {
                series.push({
                    name: __('Operating Point'),
                    type: 'scatter',
                    data: [[Controller.operatingPoint.flow, Controller.operatingPoint.efficiency]],
                    symbol: 'pin',
                    symbolSize: 15,
                    itemStyle: {
                        color: '#ff4500'
                    },
                    z: 10
                });
            }*/
            
            
            // 添加最高效率点标记
            if (Controller.maxEfficiencyPoint && Controller.maxEfficiencyPoint.flow > 0) {
                series.push({
                    name: __('Max Efficiency Point'),
                    type: 'scatter',
                    data: [[Controller.maxEfficiencyPoint.flow, Controller.maxEfficiencyPoint.efficiency]],
                    symbol: 'diamond',
                    symbolSize: 12,
                    itemStyle: {
                        color: '#00cc00'
                    },
                    z: 9
                });
            }
            
            // 设置图表选项
            var option = {
                title: {
                    text: __('Static Efficiency - Flow Curve'),
                    left: '22%',
                    x: 'center',
                    top: 10,             // 离容器顶部 10px
                    padding: [0, 0, 10, 0], // 底部再空 10px
                },

                tooltip: {
                    trigger: 'axis',        // 按轴触发
                    triggerOn: 'mousemove', // 鼠标移动时触发，也可以加 'click'
                    axisPointer: {
                      type: 'cross',        // 十字交叉线
                      snap: false,          // 关键：不再吸附到最近数据点
                      lineStyle: {          // 可以自定义线条样式
                        color: '#999',
                        width: 1,
                        type: 'dashed'
                      }
                    },
                    // 如果你不想显示默认的 tooltip 框：
                    showContent: false
                },
                legend: {
                    show: false
                    //data: Controller.availableVsps.map(function(vsp) {
                    //    return vsp + 'V';
                    //}),
                    //bottom: 0
                },
                grid: {
                    left: 30,
                    right: 15,
                    bottom: '10%',
                    top: 60,
                    containLabel: true
                },
                xAxis: {
                    type: 'value',
                    ...verticalName('Flow (' + Controller.unitSettings.flow + ')', 0, 35),
                    min: 0,
                    max: +(Controller.MAXFLOW * 1.1).toFixed(3),
                    axisPointer: {
                      show: true,
                      snap: false
                    }
                },
                yAxis: {
                    type: 'value',
                    ...verticalName(__('Static Efficiency') + ' (%)', 90),
                    min: 0,
                    max: +(maxEfficiency * 1.1).toFixed(3),
                    axisPointer: {
                      show: true,
                      snap: false
                    }
                },
                series: series
            };
            
            // 设置图表配置
            Controller.charts.efficiency.setOption(option);
        },
        
        initNoiseChart: function () {
           var chartDom = document.getElementById('noise-chart');
            if (!chartDom) return;
            
            // 创建图表实例
            Controller.charts.noise = echarts.init(chartDom, null, { renderer: 'canvas' });

            
            // 准备数据系列
            var series = [];
            var colors = ['#ff0000', '#0000ff', '#00aa00', '#ff00ff', '#ffaa00', '#00ffff'];
            var maxFlow = 0;
            var maxNoise = 0;
            var minNoise = 999999;
            
            // 为每个VSP创建一个系列
            Controller.visibleVsps.forEach(function(vsp, index) { // 2025920
                var points = Controller.pqData[vsp];
                var color = colors[index % colors.length];
                
                // 准备系列数据
                var seriesData = points.map(function(point) {
                    // 更新最大值
                    maxFlow = Math.max(maxFlow, point.flow);
                    maxNoise = Math.max(maxNoise, point.noise);
                    minNoise = Math.min(minNoise, point.noise);
                    
                    return [point.flow, point.noise];
                });
                // 如果没有最大噪音，隐藏噪音图表
                if ( maxNoise == 0 ) {
                    $('#noise-chart').hide();
                    $('.noise-col').hide();
                    return false;
                }
                
                // 添加系列
                series.push({
                    name: vsp + 'V',
                    type: 'line',
                    data: seriesData,
                    smooth: true,
                    symbol: 'none',
                    symbolSize: 6,
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
            
            // 添加操作点标记
            /*if (Controller.operatingPoint && Controller.operatingPoint.noise > 0) {
                series.push({
                    name: __('Operating Point'),
                    type: 'scatter',
                    data: [[Controller.operatingPoint.flow, Controller.operatingPoint.noise]],
                    symbol: 'pin',
                    symbolSize: 15,
                    itemStyle: {
                        color: '#ff4500'
                    },
                    z: 10
                });
            }*/

            // 添加最高效率点标记
            if (Controller.maxEfficiencyPoint && Controller.maxEfficiencyPoint.flow > 0) {
                series.push({
                    name: __('Max Efficiency Point'),
                    type: 'scatter',
                    data: [[Controller.maxEfficiencyPoint.flow, Controller.maxEfficiencyPoint.noise]],
                    symbol: 'diamond',
                    symbolSize: 12,
                    itemStyle: {
                        color: '#00cc00'
                    },
                    z: 9
                });
            }
            
            // 设置图表选项
            var option = {
                title: {
                    text: __('Noise - Flow Curve'),
                    left: 'center'
                },

                tooltip: {
                    trigger: 'axis',        // 按轴触发
                    triggerOn: 'mousemove', // 鼠标移动时触发，也可以加 'click'
                    axisPointer: {
                      type: 'cross',        // 十字交叉线
                      snap: false,          // 关键：不再吸附到最近数据点
                      lineStyle: {          // 可以自定义线条样式
                        color: '#999',
                        width: 1,
                        type: 'dashed'
                      }
                    },
                    // 如果你不想显示默认的 tooltip 框：
                    showContent: false
                },
                legend: {
                    show: false
                    //data: Controller.availableVsps.map(function(vsp) {
                    //    return vsp + 'V';
                    //}),
                    //bottom: 0
                },
                grid: {
                    left: 30,
                    right: 15,
                    bottom: '10%',
                    top: 60,
                    containLabel: true
                },
                xAxis: {
                    type: 'value',
                    ...verticalName('Flow (' + Controller.unitSettings.flow + ')', 0, 35),
                    min: 0,
                    max: +(Controller.MAXFLOW * 1.1).toFixed(3),
                    axisPointer: {
                      show: true,
                      snap: false
                    }
                },
                yAxis: {
                    type: 'value',
                    ...verticalName(__('Noise') + ' (dBA)', 90),
                    min: +(minNoise * 0.74).toFixed(2),
                    max: +(maxNoise * 1.15).toFixed(2),
                    axisPointer: {
                      show: true,
                      snap: false
                    }
                },
                series: series
            };
            
            // 设置图表配置
            Controller.charts.noise.setOption(option);
            
        },
               
        // 更新图表上的操作点
        updateChartOperatingPoint: function() {
            let settings        = Controller.unitSettings;
            let flowFactor      = UnitSettings.conversionFactors.flow[settings.flow];
            let pressureFactor  = UnitSettings.conversionFactors.pressure[settings.pressure];
            let powerFactor     = UnitSettings.conversionFactors.power[settings.power];

            let _flow = toFixedValue(Controller.operatingPoint.flow * flowFactor, settings.flow);
            let _pressure = toFixedValue(Controller.operatingPoint.pressure * pressureFactor, settings.pressure);
            let _power = toFixedValue(Controller.operatingPoint.power * powerFactor, settings.power);

            // 更新压力-风量图表
            if (Controller.charts.pressureFlow) {
                let option = Controller.charts.pressureFlow.getOption();
                
                // 查找操作点系列
                let opPointIndex = option.series.findIndex(function(series) {
                    return series.name === __('Operating Point');
                });

                if (opPointIndex !== -1) {
                    // 更新现有操作点
                    option.series[opPointIndex].data = [[_flow, _pressure]];
                    option.series[opPointIndex].label = {
                        show: true,
                        position: 'top',
                        formatter: (Controller.operatingPoint.vsp-0).toFixed(2) + ' V',
                        color: '#ff4500'
                    };
                } else {
                    // 添加新的操作点系列
                    option.series.push({
                        name: __('Operating Point'),
                        type: 'scatter',
                        data: [[_flow, _pressure]],
                        symbol: 'pin',
                        symbolSize: 15,
                        itemStyle: {
                            color: '#ff4500'
                        },
                        label: {
                            show: true,
                            position: 'top',
                            formatter: (Controller.operatingPoint.vsp-0).toFixed(2) + ' V',
                            color: '#ff4500'
                        },
                        z: 10
                    });
                }
                
                Controller.charts.pressureFlow.setOption(option);
            }
            
            // 更新功率-风量图表
            if (Controller.charts.power) {
                let powerOption = Controller.charts.power.getOption();
                
                // 查找操作点系列
                let opPointIndex = powerOption.series.findIndex(function(series) {
                    return series.name === __('Operating Point');
                });

                if (opPointIndex !== -1) {
                    // 更新现有操作点
                    powerOption.series[opPointIndex].data = [[_flow, _power]];
                    powerOption.series[opPointIndex].label = {
                        show: true,
                        position: 'top',
                        formatter:  (Controller.operatingPoint.power-0).toFixed(0) + ' W',
                        color: '#ff4500'
                    };
                } else {
                    // 添加新的操作点系列
                    powerOption.series.push({
                        name: __('Operating Point'),
                        type: 'scatter',
                        data: [[_flow, _power]],
                        symbol: 'pin',
                        symbolSize: 15,
                        itemStyle: {
                            color: '#ff4500'
                        },
                        label: {
                            show: true,
                            position: 'top',
                            formatter: (Controller.operatingPoint.power-0).toFixed(0) + ' W',
                            color: '#ff4500'
                        },
                        z: 10
                    });
                }
                
                Controller.charts.power.setOption(powerOption);
            }
            
            // 更新效率-风量图表
            if (Controller.charts.efficiency) {
                let effOption = Controller.charts.efficiency.getOption();
                
                // 查找操作点系列
                let opPointIndex = effOption.series.findIndex(function(series) {
                    return series.name === __('Operating Point');
                });
                
                if (opPointIndex !== -1) {
                    // 更新现有操作点
                    effOption.series[opPointIndex].data = [[_flow, Controller.operatingPoint.efficiency]];
                    effOption.series[opPointIndex].label = {
                        show: true,
                        position: 'top',
                        formatter: (Controller.operatingPoint.efficiency-0).toFixed(2) + '%',
                        color: '#ff4500'
                    };
                } else {
                    // 添加新的操作点系列
                    effOption.series.push({
                        name: __('Operating Point'),
                        type: 'scatter',
                        data: [[_flow, Controller.operatingPoint.efficiency]],
                        symbol: 'pin',
                        symbolSize: 15,
                        itemStyle: {
                            color: '#ff4500'
                        },
                        label: {
                            show: true,
                            position: 'top',
                            formatter: (Controller.operatingPoint.efficiency-0).toFixed(2) + '%',
                            color: '#ff4500'
                        },
                        z: 10
                    });
                }
                
                Controller.charts.efficiency.setOption(effOption);
            }
            

            // 更新噪音-风量图表
            if (Controller.charts.noise) {
                let effOption = Controller.charts.noise.getOption();
                
                // 查找操作点系列
                let opPointIndex = effOption.series.findIndex(function(series) {
                    return series.name === __('Operating Point');
                });
                
                if (opPointIndex !== -1) {
                    // 更新现有操作点
                    effOption.series[opPointIndex].data = [[_flow, Controller.operatingPoint.noise]];
                    effOption.series[opPointIndex].label = {
                        show: true,
                        position: 'top',
                        formatter:(Controller.operatingPoint.noise-0).toFixed(2) + ' dBA',
                        color: '#ff4500'
                    };
                } else {
                    // 添加新的操作点系列
                    effOption.series.push({
                        name: __('Operating Point'),
                        type: 'scatter',
                        data: [[_flow, Controller.operatingPoint.noise]],
                        symbol: 'pin',
                        symbolSize: 15,
                        itemStyle: {
                            color: '#ff4500'
                        },
                        label: {
                            show: true,
                            position: 'top',
                            formatter: (Controller.operatingPoint.noise-0).toFixed(2) + ' dBA',
                            color: '#ff4500'
                        },
                        z: 10
                    });
                }
                
                Controller.charts.noise.setOption(effOption);
            }
        },
        
        // 更新操作点表格
        updateOperatingPointTable: function() {
            // 获取当前操作点和最高效率点
            var op = Controller.operatingPoint;
            var maxEff = Controller.maxEfficiencyPoint;
            
            if (!op || !maxEff) return;
			
			console.log('Controller.operatingPoint:', op);
            
            // 转换流量单位
            var opFlow = op.flow - 0;
            var maxFlow = maxEff.flow - 0;
            if (Controller.unitSettings.flow !== 'm³/h') {
                var factor = UnitSettings.conversionFactors.flow[Controller.unitSettings.flow];
                opFlow = opFlow * factor;
                maxFlow = maxFlow * factor;
                
            }
            
            // 转换压力单位
            var opPressure = op.pressure - 0;
            var maxPressure = maxEff.pressure - 0;
            if (Controller.unitSettings.pressure !== 'Pa') {
                var factor = UnitSettings.conversionFactors.pressure[Controller.unitSettings.pressure];
                opPressure = opPressure * factor;
                maxPressure = maxPressure * factor;
                
                
            }
            
            // 转换功率单位
            var opPower = (op.power - 0) || 0;
            var maxPower = (maxEff.power - 0) || 0;
            if (Controller.unitSettings.power !== 'W') {
                var factor = UnitSettings.conversionFactors.power[Controller.unitSettings.power];
                opPower = opPower * factor;
                maxPower = maxPower * factor;
            }
            
			var opSpeed = (op.speed - 0) || 0;
			var maxSpeed = (maxEff.speed - 0) || 0;
            
            var opsfp = (opPower * 3600) / (opFlow * 1000);
            var maxsfp = (maxPower * 3600) / (maxFlow * 1000);
            
            let fefficiency = (parseFloat(op.flow) * parseFloat(op.pressure+op.dy_pressure)) / 
                                 (parseFloat(op.power) * 3600) * 100;
			
            // 更新表格
            $('#set-flow').val( toFixedValue(opFlow, Controller.unitSettings.flow) );//Controller.unitSettings.flow == 'm³/h' ? opFlow.toFixed(0) : opFlow.toFixed(3) );
            $('#op-flow').text( toFixedValue(opFlow, Controller.unitSettings.flow) );
            
            $('#set-pressure').val( toFixedValue(opPressure, Controller.unitSettings.pressure) );
            $('#op-static-pressure').text( toFixedValue(opPressure, Controller.unitSettings.pressure) );
            $('#op-power').text( toFixedValue(opPower, Controller.unitSettings.power) );
            $('#op-speed').text(opSpeed.toFixed(0));
            $('#op-sfp').text(opsfp.toFixed(2));
            $('#op-static-efficiency').text((op.efficiency - 0).toFixed(1));
            $('#op-noise').text((op.noise - 0).toFixed(1));
            
            $('#max-flow').text( toFixedValue(maxFlow, Controller.unitSettings.flow) );
            $('#max-static-pressure').text( toFixedValue(maxPressure, Controller.unitSettings.pressure) );
            $('#max-power').text( toFixedValue(maxPower, Controller.unitSettings.power) );
            $('#max-speed').text(maxSpeed.toFixed(0));
            $('#max-sfp').text(maxsfp.toFixed(2));
            $('#max-static-efficiency').text((maxEff.efficiency || 0).toFixed(1));
            $('#max-noise').text((maxEff.noise - 0).toFixed(1));
            
            $('#op-full-efficiency').text((fefficiency || 0).toFixed(1));
            $('#max-full-efficiency').text((maxEff.fefficiency || 0).toFixed(1));
        },
        
        // 使用新单位更新图表
        updateChartsWithNewUnits: function(settings, oldsettings) {
            
            let _temp_changed        = settings.temperature != oldsettings.temperature;
            let _density_changed     = settings.density != oldsettings.density;
            let flowFactor           = UnitSettings.conversionFactors.flow[settings.flow];
            let pressureFactor       = UnitSettings.conversionFactors.pressure[settings.pressure];
            let powerFactor          = UnitSettings.conversionFactors.power[settings.power];

            // 更新操作点表格数据
            Controller.updateOperatingPointTable();
            
            const newMax = UnitSettings.convertValue(Controller.MAXFLOW, 'm³/h', settings.flow, 'flow');
                 
            // 更新压力-流量图表
            if (Controller.charts.pressureFlow) {
                var option = Controller.charts.pressureFlow.getOption();
                
                // 更新坐标轴单位
                if (settings.flow) {
                    option.xAxis[0].name = __('Flow') + ' (' + settings.flow + ')';
                }
                if (settings.pressure) {
                    option.yAxis[0].name = __('Pressure') + ' (' + settings.pressure + ')';
                }
                
                // 更新数据点 - 需要转换单位
                if (settings.flow || settings.pressure) {
                    console.log('Controller.visibleVsps', Controller.visibleVsps);
                    // 更新每个VSP系列的数据
                    Controller.visibleVsps.forEach(function(vsp) { // 20250920
                        let seriesIndex = option.series.findIndex(function(series) {
                            return series.name === vsp + 'V';
                        });
                        
                        if (seriesIndex !== -1) {
                            let points = Controller.pqData[vsp];
                            option.series[seriesIndex].data = points.map(function(point) {

                                let _flow = toFixedValue(point.flow * flowFactor, settings.flow);
                                let _pressure = toFixedValue(point.pressure * pressureFactor, settings.pressure);
                                let _power = toFixedValue(point.power * powerFactor, settings.power);
                    
                                return [_flow, _pressure];
                            });
                        }
                    });
                    
                    // 更新操作点
                    let opPointIndex = option.series.findIndex(function(series) {
                        return series.name === __('Operating Point');
                    });
                    
                    if (opPointIndex !== -1 && Controller.operatingPoint) {

                        let _flow = toFixedValue(Controller.operatingPoint.flow * flowFactor, settings.flow);
                        let _pressure = toFixedValue(Controller.operatingPoint.pressure * pressureFactor, settings.pressure);
                        let _power = toFixedValue(Controller.operatingPoint.power * powerFactor, settings.power);
            
                        option.series[opPointIndex].data = [
                            [_flow, _pressure]
                        ];
                        option.series[opPointIndex].label = {
                            show: true,
                            position: 'top',
                            formatter: (Controller.operatingPoint.vsp-0).toFixed(2) + ' V',
                            color: '#ff4500'
                        };
                    }
                    
                    // 更新最高效率点
                    let maxEffIndex = option.series.findIndex(function(series) {
                        return series.name === __('Max Efficiency Point');
                    });
                    
                    if (maxEffIndex !== -1 && Controller.maxEfficiencyPoint) {

                        let _flow = toFixedValue(Controller.maxEfficiencyPoint.flow * flowFactor, settings.flow);
                        let _pressure = toFixedValue(Controller.maxEfficiencyPoint.pressure * pressureFactor, settings.pressure);
                        let _power = toFixedValue(Controller.maxEfficiencyPoint.power * powerFactor, settings.power);
            
                        option.series[maxEffIndex].data = [
                            [_flow, _pressure]
                        ];
                    }
                    
                    //更新推算数据
                    let tsIndex = option.series.findIndex(function(series) {
                        return series.name.indexOf('OP') !== -1;
                    });
                    
                    if (tsIndex !== -1) {
                        let points = Controller.newPQdata;
                        option.series[tsIndex].data = points.map(function(point) {

                            let _flow = toFixedValue(point.flow * flowFactor, settings.flow);
                            let _pressure = toFixedValue(point.pressure * pressureFactor, settings.pressure);
                            let _power = toFixedValue(point.power * powerFactor, settings.power);
                
                            return [_flow, _pressure];
                        });
                    }
                    
                    //更新阻抗
                    let imPointIndex = option.series.findIndex(function(series) {
                        return series.name === __("System Impedance");
                    });
                    //console.log('imPointIndex', imPointIndex);
                    if (imPointIndex !== -1 && Controller.impedanceData) {

                        let _flow = toFixedValue(Controller.operatingPoint.flow * flowFactor, settings.flow);
                        let _pressure = toFixedValue(Controller.operatingPoint.pressure * pressureFactor, settings.pressure);
                        let _power = toFixedValue(Controller.operatingPoint.power * powerFactor, settings.power);
                        let k = Controller.imK;
                        
                        option.series[imPointIndex].data = Controller.impedanceData.map(function(point) {

                            let _flow = toFixedValue(point[0] * flowFactor, settings.flow);
                            let _pressure = toFixedValue(point[1] * pressureFactor, settings.pressure);
                  
                            return [_flow, _pressure];
                        });
                    }                    
                    
                }
                
                console.log('option2,', option);
                // 重新计算轴范围 20250615
                //refreshAxisRange(option, 'x');
                option.xAxis[0].max = +toFixedValue(newMax * 1.1, settings.flow);
                option.xAxis[0].axisLabel = option.xAxis[0].axisLabel || {};
                option.xAxis[0].axisLabel.formatter = function(value) {
                    return toFixedValue(value, settings.flow);
                };
                refreshAxisRange(option, 'y', settings.pressure);

                Controller.charts.pressureFlow.setOption(option, true);
                console.log('重新绘制阻抗曲线,',initZK );
                //重新绘制阻抗曲线
                initZK && Controller.drawImpedanceCurve(Controller.newPQdata.length>0 ? Controller.operatingPoint : Controller.maxEfficiencyPoint); 
                initZK = true;
            }
            
            // 更新功率图表
            if (Controller.charts.power) {
                var powerOption = Controller.charts.power.getOption();
                
                // 更新坐标轴单位
                if (settings.flow) {
                    powerOption.xAxis[0].name = __('Flow') + ' (' + settings.flow + ')';
                }
                if (settings.power) {
                    powerOption.yAxis[0].name = __('Power') + ' (' + settings.power + ')';
                }
                
                // 更新数据点 - 需要转换单位
                if (settings.flow || settings.power) {

                    // 更新每个VSP系列的数据
                    Controller.visibleVsps.forEach(function(vsp) { // 20250920
                        var seriesIndex = powerOption.series.findIndex(function(series) {
                            return series.name === vsp + 'V';
                        });
                        
                        if (seriesIndex !== -1) {
                            var points = Controller.pqData[vsp];
                            powerOption.series[seriesIndex].data = points.map(function(point) {
                            let _flow = toFixedValue(point.flow * flowFactor, settings.flow);
                            let _pressure = toFixedValue(point.pressure * pressureFactor, settings.pressure);
                            let _power = toFixedValue(point.power * powerFactor, settings.power);
                
                                return [_flow, _power];
                            });
                        }
                    });
                    
                    // 更新操作点
                    var opPointIndex = powerOption.series.findIndex(function(series) {
                        return series.name === __('Operating Point');
                    });
                    
                    if (opPointIndex !== -1 && Controller.operatingPoint) {


                            let _flow = toFixedValue(Controller.operatingPoint.flow * flowFactor, settings.flow);
                            let _pressure = toFixedValue(Controller.operatingPoint.pressure * pressureFactor, settings.pressure);
                            let _power = toFixedValue(Controller.operatingPoint.power * powerFactor, settings.power);
                
                        powerOption.series[opPointIndex].data = [
                            [_flow, _power]
                        ];
                    }
                    
                    // 更新最高效率点
                    var maxEffIndex = powerOption.series.findIndex(function(series) {
                        return series.name === __('Max Efficiency Point');
                    });
                    
                    if (maxEffIndex !== -1 && Controller.maxEfficiencyPoint) {

                        let _flow = toFixedValue(Controller.maxEfficiencyPoint.flow * flowFactor, settings.flow);
                        let _pressure = toFixedValue(Controller.maxEfficiencyPoint.pressure * pressureFactor, settings.pressure);
                        let _power = toFixedValue(Controller.maxEfficiencyPoint.power * powerFactor, settings.power);
            
                        powerOption.series[maxEffIndex].data = [
                            [_flow, _power]
                        ];
                    }
                    

                    //更新推算数据
                    let tsIndex = powerOption.series.findIndex(function(series) {
                        return series.name.indexOf('OP') !== -1;
                    });
                    
                    if (tsIndex !== -1) {
                        let points = Controller.newPQdata;
                        powerOption.series[tsIndex].data = points.map(function(point) {

                            let _flow = toFixedValue(point.flow * flowFactor, settings.flow);
                            let _pressure = toFixedValue(point.pressure * pressureFactor, settings.pressure);
                            let _power = toFixedValue(point.power * powerFactor, settings.power);
                
                            return [_flow, _power];
                        });
                    }
                }
                console.log('powerOption,', powerOption);
                //20250615
                //refreshAxisRange(powerOption, 'x');
                powerOption.xAxis[0].max = +toFixedValue(newMax * 1.1, settings.flow);
                powerOption.xAxis[0].axisLabel = powerOption.xAxis[0].axisLabel || {};
                powerOption.xAxis[0].axisLabel.formatter = function(value) {
                    return toFixedValue(value, settings.flow);
                };
                refreshAxisRange(powerOption, 'y', settings.power);
                
                Controller.charts.power.setOption(powerOption, true);
            }
            
            // 更新效率图表
            if (Controller.charts.efficiency) {
                var effOption = Controller.charts.efficiency.getOption();
                
                // 更新坐标轴单位
                if (settings.flow) {
                    effOption.xAxis[0].name = __('Flow') + ' (' + settings.flow + ')';
                }
                
                // 更新数据点 - 只需转换流量单位
                if (settings.flow) {

                    // 更新每个VSP系列的数据
                    Controller.visibleVsps.forEach(function(vsp) { // 20250920
                        var seriesIndex = effOption.series.findIndex(function(series) {
                            return series.name === vsp + 'V';
                        });
                        
                        if (seriesIndex !== -1) {
                            var points = Controller.pqData[vsp];
                            effOption.series[seriesIndex].data = points.map(function(point) {

                                let _flow = toFixedValue(point.flow * flowFactor, settings.flow);
                                let _pressure = toFixedValue(point.pressure * pressureFactor, settings.pressure);
                                let _power = toFixedValue(point.power * powerFactor, settings.power);
                    
                                return [_flow, point.efficiency];
                            });
                        }
                    });
                    
                    // 更新操作点
                    var opPointIndex = effOption.series.findIndex(function(series) {
                        return series.name === __('Operating Point');
                    });
                    
                    if (opPointIndex !== -1 && Controller.operatingPoint) {

                        let _flow = toFixedValue(Controller.operatingPoint.flow * flowFactor, settings.flow);
                        let _pressure = toFixedValue(Controller.operatingPoint.pressure * pressureFactor, settings.pressure);
                        let _power = toFixedValue(Controller.operatingPoint.power * powerFactor, settings.power);
            
                        effOption.series[opPointIndex].data = [
                            [_flow, Controller.operatingPoint.efficiency]
                        ];
                    }
                    
                    // 更新最高效率点
                    var maxEffIndex = effOption.series.findIndex(function(series) {
                        return series.name === __('Max Efficiency Point');
                    });
                    
                    if (maxEffIndex !== -1 && Controller.maxEfficiencyPoint) {

                        let _flow = toFixedValue(Controller.maxEfficiencyPoint.flow * flowFactor, settings.flow);
                        let _pressure = toFixedValue(Controller.maxEfficiencyPoint.pressure * pressureFactor, settings.pressure);
                        let _power = toFixedValue(Controller.maxEfficiencyPoint.power * powerFactor, settings.power);
            
                        effOption.series[maxEffIndex].data = [
                            [_flow, Controller.maxEfficiencyPoint.efficiency]
                        ];
                    }
                    

                    //更新推算数据
                    let tsIndex = effOption.series.findIndex(function(series) {
                        return series.name.indexOf('OP') !== -1;
                    });
                    
                    if (tsIndex !== -1) {
                        let points = Controller.newPQdata;
                        effOption.series[tsIndex].data = points.map(function(point) {

                            let _flow = toFixedValue(point.flow * flowFactor, settings.flow);
                            let _pressure = toFixedValue(point.pressure * pressureFactor, settings.pressure);
                            let _power = toFixedValue(point.power * powerFactor, settings.power);
                
                            return [_flow, point.efficiency];
                        });
                    }
                }
                console.log('effOption,', effOption)
                //20250615
                //refreshAxisRange(effOption, 'x');
                effOption.xAxis[0].max = +toFixedValue(newMax * 1.1, settings.flow);
                effOption.xAxis[0].axisLabel = effOption.xAxis[0].axisLabel || {};
                effOption.xAxis[0].axisLabel.formatter = function(value) {
                    return toFixedValue(value, settings.flow);
                };
                refreshAxisRange(effOption, 'y', 2);
                
                Controller.charts.efficiency.setOption(effOption, true);
            }

            // ---- 更新噪音-风量图表 ----
            if (Controller.charts.noise) {
                const noiseOpt = Controller.charts.noise.getOption();

                // 1) 轴标题
                if (settings.flow) {
                    noiseOpt.xAxis[0].name = __('Flow') + ' (' + settings.flow + ')';
                }
                // 换 y 轴
                // noiseOpt.yAxis[0].name = __('Noise') + ' (' + settings.noise + ')';

                // 2) 数据：只需要换 x（flow）
                const flowFactor = UnitSettings.conversionFactors.flow[settings.flow];
                Controller.visibleVsps.forEach(function (vsp) { // 20250920
                    const idx = noiseOpt.series.findIndex(s => s.name === vsp + 'V');
                    if (idx !== -1) {
                        const pts = Controller.pqData[vsp];
                        noiseOpt.series[idx].data = pts.map(p => [
                            toFixedValue(p.flow * flowFactor, settings.flow),   // x
                            p.noise                                             // y 不变
                        ]);
                    }
                });

                // 3) 操作点 & 最高效率点（如果你显示的话）
                const _flow = toFixedValue(Controller.operatingPoint.flow * flowFactor, settings.flow);
                let opIdx = noiseOpt.series.findIndex(s => s.name === __('Operating Point'));
                if (opIdx !== -1) {
                    noiseOpt.series[opIdx].data = [[_flow, Controller.operatingPoint.noise]];
                }

                let maxIdx = noiseOpt.series.findIndex(s => s.name === __('Max Efficiency Point'));
                if (maxIdx !== -1) {
                    const _mflow = toFixedValue(Controller.maxEfficiencyPoint.flow * flowFactor, settings.flow);
                    noiseOpt.series[maxIdx].data = [[_mflow, Controller.maxEfficiencyPoint.noise]];
                }

                //更新推算数据
                let tsIndex = noiseOpt.series.findIndex(function(series) {
                    return series.name.indexOf('OP') !== -1;
                });
                
                if (tsIndex !== -1) {
                    let points = Controller.newPQdata;
                    noiseOpt.series[tsIndex].data = points.map(function(point) {

                        let _flow = toFixedValue(point.flow * flowFactor, settings.flow);
                        let _pressure = toFixedValue(point.pressure * pressureFactor, settings.pressure);
                        let _power = toFixedValue(point.power * powerFactor, settings.power);
            
                        return [_flow, point.noise];
                    });
                }
                
                console.log('noiseOpt,', noiseOpt);
                // 4) 自动调轴范围
                //refreshAxisRange(noiseOpt, 'x');
                noiseOpt.xAxis[0].max = +toFixedValue(newMax * 1.1, settings.flow);
                noiseOpt.xAxis[0].axisLabel = noiseOpt.xAxis[0].axisLabel || {};
                noiseOpt.xAxis[0].axisLabel.formatter = function(value) {
                    return toFixedValue(value, settings.flow);
                };
                refreshAxisRange(noiseOpt, 'y', 2);
                
                // 5) 应用
                Controller.charts.noise.setOption(noiseOpt, true);
            }

        },
        
        // 绑定事件
        bindEvents: function() {
			
			//$('.download-spec').fadeIn();
			//$('#download-spec').on('click', function() {
			//	Controller.downloadSpecification();
			//});

           // 下载规格书按钮点击事件
            $(document).on('click', '#download-spec', function() {
                Controller.downloadSpecification();
            });
            
            // 生成PDF按钮点击事件
            $(document).on('click', '#generate-pdf-btn', function() {
                Controller.generatePdfWithOptions();
            });
            
            // 布局选择改变事件 - 简易布局时禁用部分内容选项
            $(document).on('change', 'input[name="layout"]', function() {
                var layout = $(this).val();
                if (layout === 'simple') {
                    // 简易布局时，禁用部分复杂选项
                    $('input[name="content[]"]').each(function() {
                        var value = $(this).val();
                        if (['test_data', 'environmental_requirements', 'structure_features'].includes(value)) {
                            $(this).prop('checked', false).prop('disabled', true);
                        }
                    });
                } else {
                    // 详细布局时，启用所有选项
                    $('input[name="content[]"]').not('#product_images, #manufacturer_info').prop('disabled', false);
                }
            });
    
            // 窗口大小改变时重新调整图表大小
            $(window).on('resize', function() {
                Controller.resizeCharts();
            });
            
            //查看大图          
            $(document).on('click', '.fan-image img, .fan-description img', function () {
                var src = $(this).attr('src');
                Layer.photos({
                    photos: {
                        "title": "Fan Image",
                        "start": 0,
                        "data": [
                            { "alt": "Fan Image", "src": src, "thumb": src }
                        ]
                    },
                    shadeClose: true   // 点遮罩关闭
                    // keyboard:true   // Layer 默认也支持 Esc
                });
            });
            
            $(document).on('click', '.circuit-image img', function () {
                var src = $(this).attr('src');
                Layer.photos({
                    photos: {
                        "title": "Circuit Diagram",
                        "start": 0,
                        "data": [
                            { "alt": "Circuit Diagram", "src": src, "thumb": src }
                        ]
                    },
                    shadeClose: true   // 点遮罩关闭
                    // keyboard:true   // Layer 默认也支持 Esc
                });
            });
            
            $(document).on('click', '.outline-image img', function () {
                var src = $(this).attr('src');
                Layer.photos({
                    photos: {
                        "title": "Outline Diagram",
                        "start": 0,
                        "data": [
                            { "alt": "Outline Diagram", "src": src, "thumb": src }
                        ]
                    },
                    shadeClose: true   // 点遮罩关闭
                    // keyboard:true   // Layer 默认也支持 Esc
                });
            });
        
            // 计算按钮点击事件
            $('#calculate-point').on('click', function() {
                var flow = parseFloat($('#set-flow').val());
                var pressure = parseFloat($('#set-pressure').val());
                var temp = parseFloat($('#set-temp').val() || 20);
                
                // 验证输入
                if (isNaN(flow) || isNaN(pressure)) {
                    alert('Please enter valid flow and pressure values');
                    return;
                }
                
                // 转换为基准单位
                flow = Controller.convertValue(flow, Controller.unitSettings.flow, 'm³/h', 'flow');
                pressure = Controller.convertValue(pressure, Controller.unitSettings.pressure, 'Pa', 'pressure');
                
                // 设置操作点
                Controller.operatingPoint = {
                    flow: flow,
                    pressure: pressure,
                    temperature: temp
                };
                
                // 计算操作点
                Controller.calculateOperatingPoint();
            });

            // 风量压力变更
            $(document).on('change', '#set-flow, #set-pressure', function() {
                var flow = parseFloat($('#set-flow').val());
                var pressure = parseFloat($('#set-pressure').val());
                var temp = parseFloat($('#set-temp').val() || 20);
                
                // 验证输入
                if (isNaN(flow) || isNaN(pressure)) {
                    alert('Please enter valid flow and pressure values');
                    return;
                }
                
                // 转换为基准单位
                flow = Controller.convertValue(flow, Controller.unitSettings.flow, 'm³/h', 'flow');
                pressure = Controller.convertValue(pressure, Controller.unitSettings.pressure, 'Pa', 'pressure');
                
                // 设置操作点
                Controller.operatingPoint = {
                    flow: flow,
                    pressure: pressure,
                    temperature: temp
                };
                
                // 计算操作点
                Controller.calculateOperatingPoint();
            });
			
            // 温度变更
            /*
            $(document).on('change', '#input-temperature', function() {
                var temp = parseFloat($(this).val());
                if (!isNaN(temp)) {
                    Controller.operatingPoint.temperature = temp;
                    
                    // 更新密度和其他计算
                    Controller.updateDensityCalculation();
                }
            });
            */
                        
            /* ---------- 监听温度输入 ---------- */
            $(document).on('input change', '#set-temp', function () {
                const tVal = parseFloat(this.value);
                if (isNaN(tVal)) return;

                const tC   = toCelsius(tVal, getTempUnit());      // 转成 °C
                const rhoKg = densityFromTemp(tC);                // 计算 kg/m³

                // 写回密度输入框（按当前密度单位）
                const rhoDisp = fromKgPerM3(rhoKg, getDensityUnit()).toFixed(3);
                if($('#set-density').val() !== rhoDisp){
                    $('#set-density').val(rhoDisp);
                }
                Controller.operatingPoint.temperature = tC;
                Controller.operatingPoint.density = rhoKg;
                Controller.updatePressureCurveByDensity(rhoKg);   // 用 kg/m³ 更新曲线
            });

            /* ---------- 监听密度输入 ---------- */
            $(document).on('input change', '#set-density', function () {
                const rhoVal = parseFloat(this.value);
                if (isNaN(rhoVal) || rhoVal <= 0) return;

                const rhoKg = toKgPerM3(rhoVal, getDensityUnit());   // 转成 kg/m³
                const tC    = tempFromDensity(rhoKg);                // °C

                const tDispRaw = fromCelsius(tC, getTempUnit());
                const tDisp    = Math.round(tDispRaw);   // 也可用 Math.floor / ceil 取整方向自定
                
                if($('#set-temp').val() !== tDisp){
                    $('#set-temp').val(tDisp);
                }
                Controller.operatingPoint.temperature = tDisp;
                Controller.operatingPoint.density = rhoKg;

                Controller.updatePressureCurveByDensity(rhoKg);      // 用 kg/m³ 更新曲线
            });
            
            $(document).on('change', 'select[name="temperatureunit"]', function () {
                // 重新触发温度输入框的 change，让上面的代码帮忙刷新
                $('#set-temp').trigger('change');
            });

            $(document).on('change', 'select[name="densityunit"]', function () {
                $('#set-density').trigger('change');
            });

            $(document).on('click', '#export-pq-data', Controller.exportPQ);

        },  
                
        /**
         * newRho   —— 新空气密度 (kg/m³，内部统一用 SI)  
         * 仅修改 Pressure-Flow 图；Power / Efficiency 图保持不变
         */
        updatePressureCurveByDensity: function (newRho) {

            if (!Controller.charts.pressureFlow) return;

            // ① 计算本次修正比例；若密度没变就什么也不做
            const factor = newRho / Controller.currentDensity;
            if (Math.abs(factor - 1) < 1e-6) return;
            Controller.currentDensity = newRho;

            // ② 取出当前 option
            const option = Controller.charts.pressureFlow.getOption();
            const seriesArr = option.series || [];

            // ③ 遍历所有 series，把“压力”相关 Y 值乘以 factor
            seriesArr.forEach((s) => {
                if (!Array.isArray(s.data)) return;

                s.data = s.data.map((pt) => {

                    // ---- A. 最常见 [Q, P] 数组点 -----------------
                    if (Array.isArray(pt) && pt.length >= 2) {
                        return [pt[0], pt[1] * factor];
                    }

                    // ---- B. ECharts 官方推荐 {value:[Q,P], …} -----
                    if (pt && Array.isArray(pt.value) && pt.value.length >= 2) {
                        const clone = {...pt};
                        clone.value = [pt.value[0], pt.value[1] * factor];
                        return clone;
                    }

                    // ---- C. 你给出的自定义对象 --------------------
                    //     { flow:123 , pressure:456 , power:… , … }
                    if (pt && typeof pt === 'object' && 'pressure' in pt) {
                        const clone = {...pt};
                        clone.pressure = pt.pressure * factor;

                        // 若 encode 用了 value，也一并改掉
                        if (Array.isArray(pt.value) && pt.value.length >= 2) {
                            clone.value = [pt.value[0], pt.value[1] * factor];
                        }
                        return clone;
                    }

                    // 其它未知格式，原样返回
                    return pt;
                });
            });

            // ④ 自动调整 Y 轴范围（已有工具函数就用它）
            if (typeof refreshAxisRange === 'function') {
                refreshAxisRange(option, 'y', 2);
            } else if (option.yAxis) {
                // 兜底：简单找最大压力，上调到 10 的倍数
                let ymax = 0;
                seriesArr.forEach((s) => {
                    s.data.forEach((pt) => {
                        let y;
                        if (Array.isArray(pt))                  y = pt[1];
                        else if (pt?.pressure !== undefined)    y = pt.pressure;
                        else if (Array.isArray(pt?.value))      y = pt.value[1];
                        if (y > ymax) ymax = y;
                    });
                });
                if (ymax > 0) {
                    option.yAxis[0].max = Math.ceil(ymax / 10) * 10;
                }
            }

            // ⑤ 更新图表
            Controller.charts.pressureFlow.setOption(option, true);

            // ⑥ 同步页面上显示的静压（若有）
            const $op = $('#set-pressure');
            if ($op.length) {
                const old = parseFloat($op.text()) || 0;
                $op.text((old * factor).toFixed(
                    Controller.unitSettings?.pressure === 'Pa' ? 0 : 2));
            }
        },

        // ② 导出方法
        exportPQ: function () {
            var id = Fast.api.query('id');
            if (!id) { Layer.alert(__('Fan ID not found')); return; }

            // 取操作点 + 页面温度/密度
            var op = $.extend({}, Controller.operatingPoint, {
                temperature: parseFloat($('#set-temp').val()),
                density     : parseFloat($('#set-density').val())
            });

            var fd = new FormData();
            fd.append('id', id);
            fd.append('operating_point', JSON.stringify(op));
            fd.append('newpqdata', JSON.stringify(Controller.newPQdata));

            Layer.msg(__('Generating Excel…'), {icon:16,time:0});

            $.ajax({
                url         : 'fan/exportPQ',
                type        : 'POST',
                data        : fd,
                processData : false,
                contentType : false,
                xhrFields   : {responseType:'blob'},
                success: function (blob, st, xhr) {
                    Layer.closeAll();
                    var name = 'PQ_' + (xhr.getResponseHeader('Content-Disposition')||'').replace(/^.*filename="?|"?$/g,'') || 'PQcurve.xlsx';
                    var link = document.createElement('a');
                    link.href = URL.createObjectURL(blob);
                    link.download = name;
                    document.body.appendChild(link); link.click();
                    document.body.removeChild(link); URL.revokeObjectURL(link.href);
                },
                error: function () { Layer.closeAll(); Layer.alert(__('Export failed, please retry')); }
            });
        },

		// 转换值
        convertValue: function(value, fromUnit, toUnit, unitType) {
            let _value = value - 0;
            // 如果单位相同，不需要转换
            if (fromUnit === toUnit) {
                return _value;
            }
            
            // 特殊处理温度转换
            if (unitType === 'temperature') {
                // 先转换为基准单位C
                var celsiusValue = (fromUnit === 'C') ? 
                    _value : 
                    UnitSettings.conversionFactors.temperatureReverse[fromUnit](_value);
                
                // 再从基准单位转换为目标单位
                return UnitSettings.conversionFactors.temperature[toUnit](celsiusValue);
            }
            
            // 其他单位转换
            var factors = UnitSettings.conversionFactors[unitType];
            if (factors) {
                // 先转换为基准单位
                var baseValue = _value / factors[fromUnit];
                // 再从基准单位转换为目标单位
                return baseValue * factors[toUnit];
            }
            
            return _value;
        },
        /**
         * 在指定 vsp 曲线中，找到与给定 pressure 最接近的原始采样点
         *  - 该函数不做插值，而是返回曲线里现有点中 |ΔP| 最小的一个
         *  - 若曲线为空返回 null
         *
         * @param {number} pressure  目标静压
         * @param {number|string} vsp  曲线键
         * @return {{flow:number, pressure:number}|null}
         */
        getNearestPointOnVspCurveByPressure: function (pressure, vsp) {
            const curve = Controller.pqData[vsp];
            if (!curve || !curve.length) return null;

            let nearest   = curve[0];
            let minDiff   = Math.abs(curve[0].pressure - pressure);

            for (let i = 1; i < curve.length; i++) {
                const diff = Math.abs(curve[i].pressure - pressure);
                if (diff < minDiff) {
                    minDiff = diff;
                    nearest = curve[i];
                    // ★ 已经精确命中，直接返回
                    if (minDiff === 0) break;
                }
            }
            return { flow: nearest.flow, pressure: nearest.pressure };
        },
        
        /**
         * 在指定 vsp 曲线上，按欧氏距离找到距离目标 (flow,pressure) 最近的采样点
         * —— 用于“flow、pressure 都超限”场景，把操作点钉回最大 vsp 曲线
         *
         * @param {number} flow
         * @param {number} pressure
         * @param {number|string} vsp
         * @return {{flow:number, pressure:number}|null}
         */
        getNearestPointOnVspCurve2D: function (flow, pressure, vsp) {
            const curve = Controller.pqData[vsp];
            if (!curve || !curve.length) return null;

            let nearest = curve[0];
            let minDist = Math.hypot(curve[0].flow - flow, curve[0].pressure - pressure);

            for (let i = 1; i < curve.length; i++) {
                const d = Math.hypot(curve[i].flow - flow, curve[i].pressure - pressure);
                if (d < minDist) {
                    minDist = d;
                    nearest = curve[i];
                    if (d === 0) break;        // 精准命中即可提前退出
                }
            }
            return { flow: nearest.flow, pressure: nearest.pressure };
        },

        /**
         * ① 在 VSP 曲线上用线性插值求得给定 pressure 的 flow
         * ② 保障曲线经过该点：若曲线中不存在此点，则按 flow 升序插入
         *
         * @param {number} pressure
         * @param {number|string} vsp
         * @return {{flow:number, pressure:number}|null}
         */
        getOrInsertInterpolatedPointByPressure: function (pressure, vsp) {
            const curve = Controller.pqData[vsp];
            if (!curve || curve.length < 2) return null;

            // 曲线按 flow 升序，pressure 单调递减
            for (let i = 0; i < curve.length - 1; i++) {
                const p1 = curve[i];
                const p2 = curve[i + 1];

                // 找到 pressure 落在 p1、p2 之间的区间
                const minP = Math.min(p1.pressure, p2.pressure);
                const maxP = Math.max(p1.pressure, p2.pressure);
                if (pressure <= maxP && pressure >= minP) {
                    const t = (pressure - p1.pressure) / (p2.pressure - p1.pressure);
                    const flow = p1.flow + t * (p2.flow - p1.flow);

                    // 判断曲线上是否已存在该点（避免重复插入）
                    const exists = curve.some(pt =>
                        Math.abs(pt.flow - flow) < 1e-6 &&
                        Math.abs(pt.pressure - pressure) < 1e-6
                    );
                    if (!exists) {
                        // 按 flow 升序插入
                        let insertIdx = curve.findIndex(pt => pt.flow > flow);
                        if (insertIdx === -1) insertIdx = curve.length;
                        curve.splice(insertIdx, 0, { flow, pressure });
                    }
                    return { flow, pressure };
                }
            }
            return null;      // pressure 超出曲线范围
        },

        // ============ 新增边界检查方法 ============
        
        /**
         * 当点击点落在最小 / 最大 VSP 包络之外时，根据
         *  flow / pressure 是否超过极限值，返回“校正后的基准点”
         *
         *  场景说明（均以最大 VSP 曲线为参照）：
         *  ① flow、pressure 均 ≤ 最大值        → 用同一 flow 在最大 VSP 上的压力
         *  ② flow ≤ 最大值 且 pressure > 最大值 → 同①（只是调用者的原始压力已超出）
         *  ③ flow  > 最大值 且 pressure ≤ 最大值 → 用同一 pressure 在最大 VSP 上的 flow
         *  ④ 两者都超出                         → 直接采用最高效率点
         *
         *  @param {number} flow     m³/h（基准单位）
         *  @param {number} pressure Pa   （基准单位）
         *  @return {object}
         */
        checkPointBoundary: function (flow, pressure) {
            const _maxVsp = MAXVSP;
            const _minVsp = MINVSP;

            // 若曲线数据异常，直接放行
            if (!Controller.pqData[_maxVsp] || !Controller.pqData[_minVsp]) {
                console.warn('边界 VSP 曲线缺失');
                return { outOfBounds: false };
            }

            /* ----------  0) 先判断是否已在包络内 ---------- */
            const pMin = Controller.getPressureOnVspCurve(flow, _minVsp);
            const pMax = Controller.getPressureOnVspCurve(flow, _maxVsp);
            if (pMin !== null && pMax !== null &&
                pressure >= pMin && pressure <= pMax) {

                // 落在包络内，直接返回
                return { outOfBounds: false };
            }

            /* ----------  1) 计算四种超限状态 ---------- */
            const maxFlowCurve     = Controller.MAXFLOW;        // 数据集中流量极值
            const maxPressureCurve = Controller.MAXPRESSURE;    // 数据集中压力极值

            const flowOver     = flow     > maxFlowCurve;
            const pressureOver = pressure > maxPressureCurve;

            /* ----------  2) 场景 4 ：flow、pressure 均超限 ---------- */
            if (flowOver && pressureOver) {
                // 需求变更：不再跳到最高效率点，而是钉回 **最大 VSP 曲线**
                // 取最近邻采样点，保证落在曲线上 & speedRatio = 1
                const nearest = Controller.getNearestPointOnVspCurve2D(flow, pressure, _maxVsp) ||
                                Controller.pqData[_maxVsp][0];  // 兜底：取曲线首点

                return {
                    outOfBounds      : true,
                    boundaryVsp      : _maxVsp,            // ★ 关键：base = target = MAXVSP
                    adjustedFlow     : nearest.flow,
                    adjustedPressure : nearest.pressure,
                    boundaryType     : 'bothOver'         // 场景 4
                };
            }


            /* ----------  3) 场景 3 ：flow 超限，pressure 合法 ---------- 
            if (flowOver && !pressureOver) {
                const flowOnMax = Controller.getFlowOnVspCurve(pressure, _maxVsp);
                return {
                    outOfBounds      : true,
                    boundaryVsp      : _maxVsp,
                    adjustedFlow     : flowOnMax !== null ? flowOnMax : maxFlowCurve,
                    adjustedPressure : pressure,
                    boundaryType     : 'flowOver'       // 场景 3
                };
            } */
            /* ----------  3) 场景 3 ：flow 超限，pressure 合法 ---------- */
            if (flowOver && !pressureOver) {
                // 用线性插值得到“真正”在曲线上的交点，并把它插回曲线
                const interp = Controller.getOrInsertInterpolatedPointByPressure(pressure, _maxVsp);

                // 兜底：理论上 interp 不会为 null，除非曲线异常
                const correctedFlow     = interp ? interp.flow     : Controller.getFlowOnVspCurve(pressure, _maxVsp);
                const correctedPressure = interp ? interp.pressure : pressure;

                return {
                    outOfBounds      : true,
                    boundaryVsp      : _maxVsp,
                    adjustedFlow     : correctedFlow,
                    adjustedPressure : correctedPressure,
                    boundaryType     : 'flowOver'       // 场景 3
                };
            }



            /* ----------  4) 场景 1 / 2 ：flow 合法（pressure 是否超限无所谓） ---------- */
            const presOnMax = Controller.getPressureOnVspCurve(flow, _maxVsp);
            return {
                outOfBounds      : true,
                boundaryVsp      : _maxVsp,
                adjustedFlow     : flow,
                adjustedPressure : presOnMax !== null ? presOnMax : pMax,   // pMax 已含外推
                boundaryType     : pressureOver ? 'pressureOver' : 'inRange' // 场景 2 / 1
            };
        },

        // 计算操作点
        calculateOperatingPoint: function() {
            
            // 获取用户输入的风量、压力和温度
            var flow = parseFloat($('#set-flow').val());
            var pressure = parseFloat($('#set-pressure').val());
            var temperature = parseFloat($('#set-temp').val() || 20);
            
            // 验证输入
            if (isNaN(flow) || isNaN(pressure)) {
                Layer.msg(__('Please enter valid flow and pressure values'));
                return;
            }
            
            // 确保值在合理范围内
            if (flow <= 0 || pressure <= 0) {
                Layer.msg(__('Flow and pressure must be greater than zero'));
                return;
            }

            // ===== 添加这行：清空之前的推算数据 =====
            Controller.newPQdata = [];
            //Controller.projectionData = null;
    
            // 总是把“当前单位” → “基准单位”
            let _flow_m3h     = Controller.convertValue(flow,     Controller.unitSettings.flow,     'm³/h', 'flow');
            let _pressure_pa = Controller.convertValue(pressure, Controller.unitSettings.pressure, 'Pa',   'pressure');

            console.log("计算操作点:", {flow: _flow_m3h, pressure: _pressure_pa, temperature: temperature});

            // ============ 新增边界检查逻辑 ============
            // 检查点击点是否在有效推算范围内
            var boundaryCheck = Controller.checkPointBoundary(_flow_m3h, _pressure_pa);
            
            if (boundaryCheck.outOfBounds) {
                console.log("点击点超出边界，使用边界曲线:", boundaryCheck.boundaryVsp);

                // 添加这部分代码：更新 projectionData
                Controller.projectionData = {
                    baseVsp: boundaryCheck.boundaryVsp,
                    speedRatio: 1.0, // 边界曲线不需要缩放
                    targetVsp: boundaryCheck.boundaryVsp,
                    targetPoint: {
                        flow: boundaryCheck.adjustedFlow, 
                        pressure: boundaryCheck.adjustedPressure
                    }
                };
                
                // 显示边界曲线（实际上就是已有的曲线）
                Controller.showCalculatedCurve(boundaryCheck.boundaryVsp);
                
                // 直接使用边界VSP曲线的数据，不进行推算
                Controller.setOperatingPoint(
                    boundaryCheck.adjustedFlow, 
                    boundaryCheck.adjustedPressure, 
                    boundaryCheck.boundaryVsp
                );


				//阻抗
				Controller.drawImpedanceCurve(Controller.operatingPoint);
                
                // 更新输入框显示调整后的值
                $('#set-flow').val(toFixedValue(
                    Controller.convertValue(boundaryCheck.adjustedFlow, 'm³/h', Controller.unitSettings.flow, 'flow'), 
                    Controller.unitSettings.flow
                ));
                $('#set-pressure').val(toFixedValue(
                    Controller.convertValue(boundaryCheck.adjustedPressure, 'Pa', Controller.unitSettings.pressure, 'pressure'), 
                    Controller.unitSettings.pressure
                ));
                
                Layer.msg(__('Point adjusted to boundary curve: ') + boundaryCheck.boundaryVsp + 'V');
                return;
            }
    
			// ① 找出点击点所在 VSP 曲线（离得最近即可，后面要插值）20250516更新
			var closestVsp = Controller.findNearestVspCurve(_flow_m3h, _pressure_pa);
			var minDistance = Controller.calculateDistanceToCurve(
				_flow_m3h, _pressure_pa, Controller.pqData[closestVsp]
			);
			const ON_CURVE_TH  = 3;
			const onCurve      = minDistance < ON_CURVE_TH;
console.log('availableVsps:', Controller.availableVsps);
console.log('pqData sample:', Controller.pqData);
            console.log('closestVsp,', closestVsp);

			if ( onCurve && Controller.availableVsps.includes(closestVsp) ) {
				// 计算新的目标VSP
				var targetVsp = Controller.interpolateVsp(_flow_m3h, _pressure_pa, closestVsp);
                
				Controller.showCalculatedCurve(closestVsp);
                
				// 直接设为操作点，不推算
				Controller.setOperatingPoint(_flow_m3h, _pressure_pa, closestVsp);

				//阻抗
				Controller.drawImpedanceCurve(Controller.operatingPoint);
                
				console.log("点击在默认曲线点，直接使用,", targetVsp);
			} else {
				var _closestVsp = Controller.findNearestVspCurve(_flow_m3h, _pressure_pa, true);
                
            // =====避免使用极端VSP作为基准 =====
            if (_closestVsp === MINVSP) {
                // 如果最近的是极端VSP，选择次近的作为基准
                let alternatives = Controller.internalVsps.filter(v => v !== MINVSP);
                if (alternatives.length > 0) {
                    _closestVsp = alternatives.reduce((best, v) => 
                        Math.abs(v - _closestVsp) < Math.abs(best - _closestVsp) ? v : best
                    );
                }
            }
    
                console.log('_closestVsp,', _closestVsp);
				// 依据隐藏的vsp重新计算新的目标VSP
				var targetVsp = Controller.interpolateVsp(_flow_m3h, _pressure_pa, _closestVsp);
                
				// 动态确定VSP范围
				var _minVsp = Math.min.apply(null, Controller.availableVsps);
				var _maxVsp = Math.max.apply(null, Controller.availableVsps);

				// 确保VSP在可用范围内
				targetVsp = Math.max(_minVsp, Math.min(_maxVsp, targetVsp));
                
                if ( targetVsp > MAXVSP ) {
                    targetVsp = MAXVSP;
                }
                Controller.opvsp = targetVsp;
                				
				// 推算并显示新曲线
				Controller.showCalculatedCurve(targetVsp);
                
				// 设置操作点相关参数
				Controller.setOperatingPoint(_flow_m3h, _pressure_pa, targetVsp);

				//阻抗
				Controller.drawImpedanceCurve(Controller.operatingPoint);
                
				// 显示提示信息
				console.log(__('已推算 ') + targetVsp.toFixed(1) + 'V ' + __('的性能曲线'));

			}
        },

        // 更新密度计算
        updateDensityCalculation: function() {
            // 根据温度计算空气密度
            var temp = Controller.operatingPoint.temperature;
            var density = 1.293 * (273 / (273 + temp));
            
            // 更新密度显示
            $('#air-density').text(density.toFixed(3) + ' kg/m³');
            
            // 更新操作点表格
            Controller.updateOperatingPointTable();
        },
        
        // 调整图表大小
        resizeCharts: function() {
            if (Controller.charts.pressureFlow) {
                Controller.charts.pressureFlow.resize();
            }
            
            if (Controller.charts.power) {
                Controller.charts.power.resize();
            }
            
            if (Controller.charts.efficiency) {
                Controller.charts.efficiency.resize();
            }
            
            if (Controller.charts.soundPower) {
                Controller.charts.soundPower.resize();
            }
            
            if (Controller.charts.soundPressure) {
                Controller.charts.soundPressure.resize();
            }
            
            if (Controller.charts.soundPressureLevel) {
                Controller.charts.soundPressureLevel.resize();
            }
        }
    };

    return Controller;
});
