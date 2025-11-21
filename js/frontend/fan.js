/* fan.js — plans table + two charts (PQ & Power), i18n, AMD define */
define(['jquery', 'bootstrap', 'frontend', 'echarts'], function ($, undefined, Frontend, echarts) {
    
    var candidates = [];
    var selectedIdx = -1;
    var chartPQ = null, chartPower = null;

    var batchResults = {};      // rowIndex => { params, candidates }
    var currentRowIndex = null; // 当前显示的是哪一行的结果
    var currentOp = {           // 当前行的操作点（供画 PQ/Power 曲线用）
      flow: 0,
      pressure: 0
    };

    /* ====== 默认值 ====== */
    var DEFAULTS = {
      fan_type: 'AHU',                // AHU / CTF
      width: 2500,                    // mm
      height: 2500,                   // mm
      airflow: 26200,                 // m³/h
      pressure: 380,                  // Pa
      controller_location: 'inside',  // inside / outside
      redundancy: 'N+1'                 // N, N+1, ...
    };

    var savedLocal = loadSaved(); // 从 sessionStorage 读
    function genSid(){ return 's' + Date.now().toString(36) + Math.random().toString(36).slice(2,6); }
    function loadSaved(){
        try{ var x = JSON.parse(sessionStorage.getItem('fanwall_saved')||'[]'); return Array.isArray(x)?x:[]; }catch(e){ return []; }
    }
    function persistSaved(){ sessionStorage.setItem('fanwall_saved', JSON.stringify(savedLocal)); }

    /* ====== 2) 工具：解析 URL 查询串 ====== */
    function getQueryParams() {
      var q = {};
      var s = window.location.search || '';
      s.replace(/[?&]([^=&#]+)=([^&#]*)/g, function(_, k, v){
        k = decodeURIComponent(k);
        v = decodeURIComponent((v+'').replace(/\+/g, ' '));
        q[k] = v;
      });
      return q;
    }

    /* ====== 3) 工具：同步数字输入与滑块 ====== */
    function setNumberWithRange(inputId, rangeId, val){
      if (val === undefined || val === null || val === '') return;
      var $input = $('#'+inputId);
      var $range = $('#'+rangeId);
      var min = Number($range.attr('min') || 0);
      var max = Number($range.attr('max') || 999999999);
      var step = Number($range.attr('step') || 1);
      var v = Number(val);
      if (!isFinite(v)) return;
      // clamp 到滑块范围，并按 step 对齐
      v = Math.max(min, Math.min(max, v));
      v = Math.round(v / step) * step;

      $input.val(v);
      // 触发滑块的 input 事件，让现有联动逻辑生效
      $range.val(v).trigger('input');
    }

    var Controller = {

    index: function () {

      /* ------------ sliders <-> inputs sync ------------ */
      function sync(range, input){
        $(range).on('input', function(){ $(input).val(this.value); });
        $(input).on('change', function(){
          var val = parseFloat(this.value);
          var min = parseFloat($(range).attr('min')) || 0;
          var max = parseFloat($(range).attr('max')) || 9e15;
          if (isNaN(val)) val=min;
          val=Math.max(min,Math.min(max,val));
          $(range).val(val); this.value = val;
        });
      }
      sync('#airflow-range','#airflow');
      sync('#pressure-range','#pressure');
      sync('#width-range','#width');
      sync('#height-range','#height');

      /* ------------ utils ------------ */
      function nf(x, d){ if(x===null||x===undefined||x==='') return '-'; d=(typeof d==='number')?d:2; var n=Number(x); if(isNaN(n)) return x; return n.toFixed(d); }
      function nint(x){ if(x===null||x===undefined||x==='') return '-'; var n=Math.round(Number(x)); return isNaN(n)?x:n.toString(); }
      function esc(s){ return String(s||'').replace(/[&<>"']/g, function(m){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m];}); }

      /* ------------ state ------------ */
      var candidates = [];       // plans
      var selectedIdx = -1;      // current selected index
      var chartPQ = null, chartPower = null;

      function disposeCharts(){
        if(chartPQ){ chartPQ.dispose(); $(window).off('resize.chartPQ'); chartPQ=null; }
        if(chartPower){ chartPower.dispose(); $(window).off('resize.chartPower'); chartPower=null; }
      }

      /* ------------ render table ------------ */
      function renderPlansTable(list){
        var $box = $('#plans-box').empty();
        $('#plans-toolbar').show();
        var html = '';
            html += '<div class="table-scroll">';  // ⬅️ 新容器（可横向滚动 + 粘性表头）
            html += '<table class="table table-bordered table-hover table-condensed solution-table" id="plans-table">';

        html += '<thead><tr>'
              + '<th>'+__('#')+'</th>'
              + '<th>'+__('Model')+'</th>'
              + '<th>'+__('Exact Units')+'</th>'
              + '<th>'+__('Estimated Units')+'</th>'
              + '<th>'+__('Configured Units')+'</th>'
              + '<th>'+__('Running Power (kW)')+'</th>'
              + '<th>'+__('Running Speed (rpm)')+'</th>'
              + '<th>'+__('Duty Point Efficiency (%)')+'</th>'
              + '<th>'+__('Rated Power (kW)')+'</th>'
              + '<th>'+__('Rated Current (A)')+'</th>'
              + '<th>'+__('Nominal Airflow (m³/h)')+'</th>'
              + '<th>'+__('Nominal Static Pressure (Pa)')+'</th>'
              + '</tr></thead><tbody>';

        list.forEach(function(it, i){
          html += '<tr data-idx="'+i+'">'
                + '<td>'+(i+1)+'</td>'
                + '<td>'+esc(it.fan_model)+'</td>'
                + '<td>'+nf(it.qty_exact,2)+'</td>'
                + '<td>'+nint(it.qty)+'</td>'
                + '<td>'+nint(it.qty_config)+'</td>'
                + '<td>'+nf(it.run_power_kw,3)+'</td>'
                + '<td>'+nint(it.run_speed)+'</td>'
                + '<td>'+nf(it.efficiency_pct,2)+'</td>'
                + '<td>'+nf(it.rated_power_total_kw,3)+'</td>'
                + '<td>'+nf(it.rated_current_total_a,2)+'</td>'
                + '<td>'+nf(it.nominal_flow_total,0)+'</td>'
                + '<td>'+nf(it.nominal_pressure,0)+'</td>'
                + '</tr>';
        });
        html += '</tbody></table></div>';
        $box.html(html);

        // click to select
        $('#plans-table tbody tr').on('click', function(){
          var idx = Number($(this).data('idx'));
          selectPlan(idx);
        });
      }

      /* ------------ select & draw charts ------------ */
function selectPlan23(idx){
  if (idx < 0 || idx >= candidates.length) return;
  selectedIdx = idx;

  // 高亮表格行
  $('#plans-table tbody tr').removeClass('selected');
  $('#plans-table tbody tr[data-idx="'+ idx +'"]').addClass('selected');

  // 读取“操作点”（用户输入的目标风量/静压）
  var opFlow = +($('#airflow').val() || 0);
  var opPress = +($('#pressure').val() || 0);
  var op = { flow: opFlow, pressure: opPress };

  // 容器先可见（避免初次 0 宽），但隐藏内容避免闪烁
  var $box = $('#charts-box');
  $box.css('visibility','hidden').show();

  // 清理旧图
  disposeCharts();

  // 一帧后再初始化（保证有可用宽度）
  requestAnimationFrame(function(){
    var item = candidates[idx];

    // 按新签名绘图：drawPQ(container, pqSingle, pqWall, op)
    chartPQ = drawPQ('#chart-pq', item.pq_single, item.pq_wall, op);

    // 功率图：drawPower(container, powerSingle, powerWall, opFlow)
    chartPower = drawPower('#chart-power', item.power_single, item.power_wall, op.flow);

    // 显示并自适应
    $box.css('visibility','visible');
    if (chartPQ)    chartPQ.resize();
    if (chartPower) chartPower.resize();
  });

  // 滚动到表格位置
  $('html,body').stop(true).animate({ scrollTop: $('#plans-box').offset().top - 100 }, 200);
}


function toPairs(arr, xKey, yKey) {
  return (arr || []).map(function(p) {
    // X：优先 xKey，其次 flow；允许 0
    var x;
    if (xKey && p[xKey] != null) {
      x = p[xKey];
    } else {
      x = p.flow;
    }

    // Y：优先 yKey，其次 pressure，再次 power_kw；也都允许为 0
    var y;
    if (yKey && p[yKey] != null) {
      y = p[yKey];
    } else if (p.pressure != null) {
      y = p.pressure;
    } else if (p.power_kw != null) {
      y = p.power_kw;
    } else {
      y = NaN;
    }

    return [ Number(x), Number(y) ];
  });
}


// 根据容器宽度生成更紧凑的 grid 留白
// 根据容器宽度生成更紧凑的 grid 留白（为双 X 轴 + dataZoom 预留空间）
function tightGridFor(el) {
  var w = $(el).width() || 600;

  var left   = Math.max(56, Math.min(72, Math.round(w * 0.08)));
  var right  = Math.max(16, Math.round(w * 0.03));
  // 底部要同时容纳：主 X 轴 + 次 X 轴 + dataZoom
  var bottom = Math.max(70, Math.min(90, Math.round(w * 0.14)));
  var top    = 32;

  return {
    left: left,
    right: right,
    top: top,
    bottom: bottom,
    containLabel: true
  };
}


// 以数据决定轴范围，保留少量 padding；clampZero 为 true 时最小值不小于 0
function paddedRange(vals, padRatio, clampZero) {
  vals = (vals || []).filter(function(v){ return isFinite(v); });
  if (!vals.length) return {};
  var min = Math.min.apply(null, vals), max = Math.max.apply(null, vals);
  var span = max - min; if (span <= 0) { span = max || 1; min = max - span * 0.1; }
  var pad = (typeof padRatio === 'number' ? padRatio : 0.05) * span;
  var outMin = min - pad, outMax = max + pad;
  if (clampZero) outMin = Math.max(0, outMin);
  return { min: outMin, max: outMax };
}

/* ===== 千分位与小数格式化 ===== */
function toThousands(n, fixed) {
  if (n == null || isNaN(n)) return '-';
  var x = (fixed != null) ? Number(n).toFixed(fixed) : String(Number(n));
  var parts = x.split('.');
  parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return parts.join('.');
}

/* ===== 统一的网格/坐标轴样式（和详情页一致） ===== */
function baseGrid() {
  return { left: 80, right: 80, top: 40, bottom: 60, containLabel: true };
}
function axisName(name, rotate) {
  return {
    name: name,
    nameLocation: 'middle',
    nameGap: rotate ? 50 : 36,
    nameRotate: rotate ? 90 : 0,
    nameTextStyle: { fontSize: 12, fontWeight: 500 }
  };
}
function crossPointer() {
    
    return  {
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
    };
}
/* =======================================================================
 *  PQ 曲线（双 X 轴：上=风机墙，下=单机，带 OP 点，单机压缩在左侧）
 * ======================================================================= */
function drawPQ(container, pqSingle, pqWall, op) {
  var el = (typeof container === 'string') ? document.querySelector(container) : container;
  if (!el) return;

  var chart = echarts.init(el, null, { renderer: 'canvas' });

  // 线性插值：给定曲线 [[x,y],…] 与 y0，返回 x
  function interpXAtY(points, y0) {
    if (!points || points.length < 2) return null;
    var pts = points.slice().sort(function (a, b) { return a[1] - b[1]; });
    if (y0 < pts[0][1] || y0 > pts[pts.length - 1][1]) return null;
    for (var i = 0; i < pts.length - 1; i++) {
      var x1 = pts[i][0], y1 = pts[i][1],
          x2 = pts[i + 1][0], y2 = pts[i + 1][1];
      if (y0 >= y1 && y0 <= y2) {
        var t = (y0 - y1) / Math.max(1e-9, (y2 - y1));
        return x1 + (x2 - x1) * t;
      }
    }
    return null;
  }
  //console.log('pqSingle', pqSingle);
  //console.log('pqWall', pqWall);
  //console.log('op', op);

  var sSingle = toPairs(pqSingle); // [[flow, pressure], ...]
  var sWall   = toPairs(pqWall);   // [[flow, pressure], ...]

  if (!sSingle.length && !sWall.length) {
    chart.clear();
    return chart;
  }

  // 计算 X / Y 范围
  var maxWallX   = 0;
  var minWallX   = Infinity;
  sWall.forEach(function (p) {
    maxWallX = Math.max(maxWallX, p[0]);
    minWallX = Math.min(minWallX, p[0]);
  });
  if (!isFinite(minWallX)) minWallX = 0;
  if (op && op.flow) {
    maxWallX = Math.max(maxWallX, Number(op.flow));
    minWallX = Math.min(minWallX, Number(op.flow));
  }
  maxWallX = Math.ceil(maxWallX * 1.1);
  minWallX = Math.max(0, Math.floor(minWallX * 0.9));

  var maxSingleX = 0;
  var minSingleX = Infinity;
  sSingle.forEach(function (p) {
    maxSingleX = Math.max(maxSingleX, p[0]);
    minSingleX = Math.min(minSingleX, p[0]);
  });
  if (!isFinite(minSingleX)) minSingleX = 0;
  maxSingleX = Math.ceil(maxSingleX * 1.1);
  minSingleX = Math.max(0, Math.floor(minSingleX * 0.9));

  var maxY = 0;
  sSingle.forEach(function (p) { maxY = Math.max(maxY, p[1]); });
  sWall.forEach(function (p) { maxY = Math.max(maxY, p[1]); });
  if (op && op.pressure) maxY = Math.max(maxY, Number(op.pressure));
  maxY = Math.ceil(maxY * 1.1);


  // 单台轴压缩系数：只占主轴宽度的 40%
  var singleVisibleRatio = 0.4;
  // 轴内部使用放大的 range，曲线只画在左侧 40%
  var singleAxisMin = minSingleX;
  var singleAxisMax = maxSingleX / singleVisibleRatio;

  // OP 点（按风机墙曲线插值）
  var opPoint = null;
  if (op && op.pressure) {
    var fx = interpXAtY(sWall, Number(op.pressure));
    if (fx != null) opPoint = [fx, Number(op.pressure)];
  }

    // 网格：在 tightGrid 基础上，把左侧和底部再放大一点
    var grid = {
            left: 45,
            right: 35,
            bottom: 60,
            top: 55,
            containLabel: true
    };

  chart.setOption({
    legend: { top: 16, bottom:16, left: 'center' },
    grid: grid,
    tooltip: crossPointer(),

    xAxis: [
      {
        // 主 X 轴：风机墙总风量
        type: 'value',
        min: minWallX,
        max: maxWallX,
        name: __('Air flow') + ' (m³/h)',
        nameLocation: 'middle',
        // nameGap 加大，让文字跑到第二条 X 轴下方
        nameGap: 64,
        axisLabel: {
          show: true,
          color: '#666',
          formatter: function (v) { return toThousands(v, 0); }
        },
        axisLine: { lineStyle: { color: '#666' } },
        axisPointer: {
            show: true,
            snap: false
        }
      },
      {
        // 次 X 轴：单机风量（在主轴下方，淡色，压缩显示）
        type: 'value',
        position: 'bottom',
        offset: 26,                // 贴近图表底部，主轴 name 在它下面
        min: singleAxisMin,
        max: singleAxisMax,
        name: '',
        axisLine: { lineStyle: { color: '#d9d9d9' } },
        axisLabel: {
          show: true,
          color: '#b8b8b8',
          // 把内部放大的数值乘回 ratio，显示真实单机风量
          formatter: function (v) {
            return toThousands(v * singleVisibleRatio, 0);
          }
        },
        splitLine: { show: false },
        axisPointer: {
            show: true,
            snap: false
        }
      }
    ],

    yAxis: {
        type: 'value',
        min: 0,
        max: maxY,
        name: __('Static pressure') + '(Pa)',
        nameLocation: 'middle',
        nameGap: 56,
        nameRotate: 90,
        nameTextStyle: { fontSize: 12, fontWeight: 500, color: '#666' },
        axisLabel: {
            show: true,
            color: '#666',
            formatter: function (v) { return toThousands(v, 0); }
        },
        axisLine: { lineStyle: { color: '#666' } },
        axisPointer: {
            show: true,
            snap: false
        }
    },
    /*
    dataZoom: [
      {
        type: 'inside',
        xAxisIndex: [0, 1],
        filterMode: 'none'
      },
      {
        type: 'slider',
        xAxisIndex: [0, 1],
        height: 14,
        bottom: 8          // 稍微往下放一点，和主轴 name 分层
      }
    ],*/

    series: [
      {
        name: __('Single fan PQ'),
        type: 'line',
        data: sSingle,
        smooth: true,
        symbol: 'none',
        lineStyle: { width: 2 },
        xAxisIndex: 1      // 使用“单机”X 轴（已经被压缩）
      },
      {
        name: __('Fan Wall PQ'),
        type: 'line',
        data: sWall,
        smooth: true,
        symbol: 'none',
        lineStyle: { width: 2 },
        xAxisIndex: 0      // 使用“总风量”X 轴
      }
    ].concat(opPoint ? [{
      name: __('Operating Point'),
      type: 'scatter',
      data: [opPoint],
      symbol: 'pin',
      symbolSize: 12,
      xAxisIndex: 0,
      itemStyle: { color: '#e74c3c' },
      label: {
        show: false,
        position: 'top',
        color: '#e74c3c',
        fontSize: 11,
        formatter: function (p) {
          return 'OP\n' +
                 toThousands(p.value[0], 0) +
                 ' / ' +
                 toThousands(p.value[1], 0);
        }
      },
      z: 9
    }] : [])
  });

  $(window).off('resize.chartPQ').on('resize.chartPQ', function(){ chart.resize(); });
  return chart;
}

/* =======================================================================
 * Power vs Airflow（双 X + 双 Y：左=总功率(kW)，右=单机功率(W)；
 * 单机曲线在左侧 40% 宽度）
 * ======================================================================= */
function drawPower(container, powerSingle, powerWall, opFlow) {
  var el = (typeof container === 'string') ? document.querySelector(container) : container;
  if (!el) return;

  var chart = echarts.init(el, null, { renderer: 'canvas' });

  // 线性插值：给定曲线 [[x,y],…] 与 x0，返回 y
  function interpY(points, x0) {
    if (!points || points.length < 2) return null;
    var pts = points.slice().sort(function (a, b) { return a[0] - b[0]; });
    if (x0 < pts[0][0] || x0 > pts[pts.length - 1][0]) return null;
    for (var i = 0; i < pts.length - 1; i++) {
      var x1 = pts[i][0], y1 = pts[i][1],
          x2 = pts[i + 1][0], y2 = pts[i + 1][1];
      if (x0 >= x1 && x0 <= x2) {
        var t = (x0 - x1) / Math.max(1e-9, (x2 - x1));
        return y1 + (y2 - y1) * t;
      }
    }
    return null;
  }

  var sSingleKW = toPairs(powerSingle); // 单机：[[flow, kW], ...]
  var sWallKW   = toPairs(powerWall);   // 风机墙：[[flow, kW], ...]

  if (!sSingleKW.length && !sWallKW.length) {
    chart.clear();
    return chart;
  }

  // X 轴范围
  var maxWallX = 0, minWallX = Infinity;
  sWallKW.forEach(function (p) {
    maxWallX = Math.max(maxWallX, p[0]);
    minWallX = Math.min(minWallX, p[0]);
  });
  if (!isFinite(minWallX)) minWallX = 0;
  if (opFlow) {
    maxWallX = Math.max(maxWallX, Number(opFlow));
    minWallX = Math.min(minWallX, Number(opFlow));
  }
  maxWallX = Math.ceil(maxWallX * 1.1);
  minWallX = Math.max(0, Math.floor(minWallX * 0.9));

  var maxSingleX = 0, minSingleX = Infinity;
  sSingleKW.forEach(function (p) {
    maxSingleX = Math.max(maxSingleX, p[0]);
    minSingleX = Math.min(minSingleX, p[0]);
  });
  if (!isFinite(minSingleX)) minSingleX = 0;
  maxSingleX = Math.ceil(maxSingleX * 1.1);
  minSingleX = Math.max(0, Math.floor(minSingleX * 0.9));

  // Y 轴范围：左 kW，右 W
  var yLeftMax = 0;
  sWallKW.forEach(function (p) { yLeftMax = Math.max(yLeftMax, p[1]); });
  yLeftMax = +(yLeftMax * 1.1).toFixed(2);

  var sSingleW = sSingleKW.map(function (p) { return [p[0], p[1] * 1000]; });
  var yRightMax = 0;
  sSingleW.forEach(function (p) { yRightMax = Math.max(yRightMax, p[1]); });
  yRightMax = Math.ceil(yRightMax * 1.1);

  // 单机 X 轴的压缩系数：只占主轴宽度 40%
  var singleVisibleRatio = 0.4;
  var singleAxisMin = minSingleX;
  var singleAxisMax = maxSingleX / singleVisibleRatio;

  // OP 功率（按墙体曲线插值）
  var opPW = null;
  if (opFlow) {
    opPW = interpY(sWallKW, Number(opFlow));
  }

    var grid = {
            left: 50,
            right: 50,
            bottom: 60,
            top: 55,
            containLabel: true
    };

  chart.setOption({
    legend: { top: 16, bottom:16, left: 'center' },
    grid: grid,
    tooltip: crossPointer(),

    xAxis: [
      {
        // 主 X 轴：总风量
        type: 'value',
        min: minWallX,
        max: maxWallX,
        name: __('Air flow') + ' (m³/h)',
        nameLocation: 'middle',
        nameGap: 64,                         // name 更往下，避开第二 X 轴
        axisLabel: {
          color: '#666',
          formatter: function (v) { return toThousands(v, 0); }
        },
        axisLine: { lineStyle: { color: '#666' } },
        axisPointer: {
            show: true,
            snap: false
        }
      },
      {
        // 次 X 轴：单机风量（淡色，压缩）
        type: 'value',
        position: 'bottom',
        offset: 26,
        min: singleAxisMin,
        max: singleAxisMax,
        name: '',
        axisLine: { lineStyle: { color: '#d9d9d9' } },
        axisLabel: {
          color: '#b8b8b8',
          formatter: function (v) {
            // 显示真实单机风量
            return toThousands(v * singleVisibleRatio, 0);
          }
        },
        splitLine: { show: false },
        axisPointer: {
            show: true,
            snap: false
        }
      }
    ],

    yAxis: [
      {
        // 左 Y 轴：风机墙功率（kW）
        type: 'value',
        min: 0,
        max: yLeftMax,
        name: __('Power') + ' (kW)',
        nameLocation: 'middle',
        nameGap: 56,
        nameRotate: 90,
        nameTextStyle: { fontSize: 12, fontWeight: 500, color: '#666' },
        axisLabel: {
          color: '#666',
          formatter: function (v) { return toThousands(v, 2); }
        },
        axisLine: { lineStyle: { color: '#666' } },
        axisPointer: {
            show: true,
            snap: false
        }
      },
      {
        // 右 Y 轴：单机功率（W）
        type: 'value',
        position: 'right',
        min: 0,
        max: yRightMax,
        name: __('Power (single)') + ' (W)',
        nameLocation: 'middle',
        nameGap: 56,
        nameRotate: 90,
        axisLine: { lineStyle: { color: '#d9d9d9' } },
        axisLabel: {
          color: '#b8b8b8',
          formatter: function (v) { return toThousands(v, 0); }
        },
        nameTextStyle: { color: '#b8b8b8' },
        splitLine: { show: false }
      }
    ],
    /*
    dataZoom: [
      {
        type: 'inside',
        xAxisIndex: [0, 1],
        filterMode: 'none'
      },
      {
        type: 'slider',
        xAxisIndex: [0, 1],
        height: 14,
        bottom: 8
      }
    ],
    */
    series: [
      {
        // 单机功率曲线：单机 X 轴 + 单机 Y 轴(W)
        name: __('Single Power'),
        type: 'line',
        data: sSingleW,
        smooth: true,
        symbol: 'none',
        lineStyle: { width: 2 },
        xAxisIndex: 1,
        yAxisIndex: 1
      },
      {
        // 风机墙功率：主 X + 主 Y
        name: __('Fan Wall Power'),
        type: 'line',
        data: sWallKW,
        smooth: true,
        symbol: 'none',
        symbolSize: 6,
        lineStyle: {
            width: 2,
            color: '#00aa00'
        },
        itemStyle: {
            color: '#00aa00'
        },
        connectNulls: true,
        z: 1
      }
    ].concat(opPW != null ? [{
      // OP 点（在墙体 kW 曲线上）
      name: __('Operating Power'),
      type: 'scatter',
      data: [[Number(opFlow), Number(opPW)]],
      symbol: 'pin',
      symbolSize: 12,
      xAxisIndex: 0,
      itemStyle: { color: '#e74c3c' },
      label: {
        show: false,
        position: 'top',
        color: '#e67e22',
        fontSize: 11,
        formatter: function (p) {
          return 'OP\n' +
                 toThousands(p.value[0], 0) +
                 ' / ' +
                 toThousands(p.value[1], 2) + ' kW';
        }
      },
      z: 9
    }] : [])
  });

  $(window).off('resize.chartPower').on('resize.chartPower', function(){ chart.resize(); });
  return chart;
}



      /* ------------ saved list rendering ------------ */
      function renderSaved(list){
        var $panel = $('#fanwall-saved');
        var $wrap  = $('#fanwall-saved-list').empty();

        if (!list || !list.length){
          $wrap.append('<div class="list-group-item text-muted">'+__('(Empty)')+'</div>');
          $panel.hide();
          return;
        }

        $panel.show();
        list.forEach(function(it, idx){
          var sid = it._sid || genSid();     // 本地唯一 ID
          it._sid = sid;

          var title = esc(
            (it.project_code || '') + ' / ' +
            (it.device_code  || '') + ' - ' +
            (it.product_model || it.fan_model || '')
          );

          var html =
            '<div class="saved-note" data-sid="'+sid+'" title="'+title+'">'+
              '<i class="fa fa-sticky-note-o"></i>'+
              '<span class="saved-note-index">'+(idx+1)+'</span>'+
              '<button type="button" class="saved-note-remove" data-sid="'+sid+'" title="'+__('Delete')+'">×</button>'+
            '</div>';

          $wrap.append(html);
        });
      }
      
      /* ------------ 打开已保存方案详情弹层 ------------ */
      function openSavedDetail(item){
        if (!item) return;

        var html =
          '<div style="padding:16px 20px 8px 20px;font-size:13px;line-height:1.7;">' +
            '<h4 style="margin-top:0;margin-bottom:10px;">'
              + esc(item.project_code||'') + ' / ' + esc(item.device_code||'') +
            '</h4>' +
            '<div><strong>'+esc(__('Project Name'))+':</strong> '+esc(item.project_name||'')+'</div>' +
            '<div><strong>'+esc(__('Fan Type'))+':</strong> '+esc(item.fan_type||'')+'</div>' +
            '<div><strong>'+esc(__('Fan Model'))+':</strong> '+esc(item.product_model||item.fan_model||'')+'</div>' +
            '<div><strong>'+esc(__('Configured Units'))+':</strong> '+(item.qty_config||'-')+'</div>' +
            '<div><strong>'+esc(__('Target Airflow'))+':</strong> '+esc(item.target_airflow||'-')+' m³/h</div>' +
            '<div><strong>'+esc(__('Target Static Pressure'))+':</strong> '+esc(item.target_pressure||'-')+' Pa</div>' +
            '<div><strong>'+esc(__('Opening Size'))+':</strong> '
              + esc(item.install_w||'-')+' × '+esc(item.install_h||'-')+' mm</div>' +
            '<div><strong>'+esc(__('Redundancy'))+':</strong> '+esc(item.redundancy||'-')+'</div>' +
            '<hr style="margin:10px 0;">' +
            '<div><strong>'+esc(__('Running Power (kW)'))+':</strong> '+nf(item.run_power_total_kw,3)+'</div>' +
            '<div><strong>'+esc(__('Duty Point Efficiency (%)'))+':</strong> '+nf(item.work_efficiency_pct,2)+'</div>' +
          '</div>' +
          '<div style="padding:0 20px 16px 20px;text-align:right;">' +
            '<button type="button" class="btn btn-default btn-sm btn-export-roi">'+esc(__('Export ROI'))+'</button> '+
            '<button type="button" class="btn btn-primary btn-sm btn-export-proposal">'+esc(__('Export Proposal'))+'</button>'+
          '</div>';

        var L = window.Layer || window.layer;
        if (!L || !L.open) {
          alert('Saved Case: ' + (item.project_code||'') + ' / ' + (item.device_code||''));
          return;
        }

        L.open({
          type: 1,
          title: __('Saved Fan-Wall Case'),
          area: ['520px','auto'],
          shadeClose: true,
          content: html,
          success: function(layero, index){
            // 在弹层内绑定两个按钮的点击事件
            $(layero).on('click', '.btn-export-roi', function(){
              Fast.api.ajax({
                url: 'fan/exportROI',
                type: 'POST',
                data: { id: item.id || 0, selection: item }
              }, function(res){
                (window.Layer&&Layer.msg)?Layer.msg(__('ROI export task created (stub)')):0;
                return false;
              });
            });

            $(layero).on('click', '.btn-export-proposal', function(){
              Fast.api.ajax({
                url: 'fan/exportProposal',
                type: 'POST',
                data: { id: item.id || 0, selection: item }
              }, function(res){
                (window.Layer&&Layer.msg)?Layer.msg(__('Proposal export task created (stub)')):0;
                return false;
              });
            });
          }
        });
      }

      renderSaved(savedLocal);



      /* ------------ filter ------------ 
      $('#configure-btn').on('click', function(){
        var params = {
          fan_type: $('input[name="fan_type"]:checked').val(),
          width: $('#width').val(), height: $('#height').val(),
          airflow: $('#airflow').val(), pressure: $('#pressure').val(),
          voltage: $('input[name="voltage"]:checked').val(),
          controller_location: $('input[name="controller_location"]:checked').val(),
          project_code: $('#project_code').val(),
          project_name: $('#project_name').val(),
          device_code:  $('#device_code').val(),
          redundancy:   $('#redundancy').val()
        };
        if(!params.airflow || !params.pressure){
          (window.Layer&&Layer.alert)?Layer.alert(__('Please fill in target airflow and static pressure')):alert(__('Please fill in target airflow and static pressure'));
          return;
        }

        $('#result-box').html('<div class="text-center text-muted" style="padding:40px 0;"><i class="fa fa-spinner fa-spin"></i> '+__('Calculating plans...')+'</div>');
        $('#plans-box').empty(); $('#charts-box').hide(); disposeCharts(); selectedIdx=-1;

        Fast.api.ajax({url:'fan/configure', data:params}, function(res){
          candidates = res.candidates || [];
          if(!candidates.length){
            $('#result-box').html('<div class="alert alert-warning">'+__('No matching fan model found.')+'</div>');
            return false;
          }
          $('#result-box').empty();
          renderPlansTable(candidates);

          // choose default: minimal estimated units, fallback to configured, then minimal running power
          var best = 0, bestKey = Number.MAX_VALUE, bestCfg = Number.MAX_VALUE, bestPow = Number.MAX_VALUE;
          candidates.forEach(function(it,i){
            var k1 = Number(it.qty)||1e9;
            var k2 = Number(it.qty_config)||1e9;
            var k3 = Number(it.run_power_kw)||1e9;
            if (k1<bestKey || (k1===bestKey && (k2<bestCfg || (k2===bestCfg && k3<bestPow)))){
              best=i; bestKey=k1; bestCfg=k2; bestPow=k3;
            }
          });
          selectPlan(best);
          (window.Layer&&Layer.msg)?Layer.msg(__('Calculation succeeded'),{icon:1}):0;
          return false;
        });
      });
      */


// ================== 20251119 start


function buildCriteriaRowHtml(idx, data) {
  data = data || {};
  var rowIndex = idx;  // 从 0 开始
  var displayIndex = idx + 1;

  function esc(v){ return v == null ? '' : String(v); }

  return '' +
    '<tr class="criteria-row" data-row-index="'+rowIndex+'">' +
      '<td>'+ displayIndex +'</td>' +
      '<td><input type="text" class="form-control input-sm input-device" value="'+ esc(data.device_code) +'"></td>' +
      '<td><input type="number" min="0" step="1" class="form-control input-sm input-airflow" value="'+ esc(data.airflow) +'"></td>' +
      '<td><input type="number" min="0" step="1" class="form-control input-sm input-pressure" value="'+ esc(data.pressure) +'"></td>' +
      '<td><input type="number" min="0" step="0.01" class="form-control input-sm input-power" value="'+ esc(data.power) +'"></td>' +
      '<td><input type="number" min="0" step="1" class="form-control input-sm input-width" value="'+ esc(data.width) +'"></td>' +
      '<td><input type="number" min="0" step="1" class="form-control input-sm input-height" value="'+ esc(data.height) +'"></td>' +
      '<td>' +
        '<select class="form-control input-sm input-controller">' +
          '<option value=""></option>' +
          '<option value="inside" selected>'+__('Inside')+'</option>' +
          '<option value="outside">'+__('Outside')+'</option>' +
        '</select>' +
      '</td>' +
      '<td>' +
        '<select class="form-control input-sm input-redundancy">' +
          '<option value=""></option>' +
          '<option value="N-1">N-1</option>' +
          '<option value="N+0" selected>N+0</option>' +
          '<option value="N+1">N+1</option>' +
          '<option value="N+2">N+2</option>' +
          '<option value="N+3">N+3</option>' +
          '<option value="N+4">N+4</option>' +
          '<option value="N+5">N+5</option>' +
          '<option value="N">'+__('N + N(Double Units)')+'</option>' +
        '</select>' +
      '</td>' +
      '<td class="criteria-status"><span class="text-status-empty">'+__('Not filtered')+'</span></td>' +
    '</tr>';
}

// 根据当前 tbody 行数追加一行
function addCriteriaRow() {
  var $tbody = $('#criteria-table tbody');
  var idx = $tbody.children('tr.criteria-row').length;
  $tbody.append(buildCriteriaRowHtml(idx));
}

function getRowParams($tr) {
  return {
    rowIndex: Number($tr.data('row-index')),
    device_code: $tr.find('.input-device').val().trim(),
    airflow: $tr.find('.input-airflow').val(),
    pressure: $tr.find('.input-pressure').val(),
    power: $tr.find('.input-power').val(),
    width: $tr.find('.input-width').val(),
    height: $tr.find('.input-height').val(),
    controller_location: $tr.find('.input-controller').val(),
    redundancy: $tr.find('.input-redundancy').val()
  };
}

// 判断一行是否完全为空（不需要筛选）
function isRowEmpty(p) {
  return !p.device_code &&
         !p.airflow && !p.pressure && !p.power &&
         !p.width && !p.height;
}

// 更新状态列
function updateRowStatus(rowIndex, type, extra) {
  var $row = $('#criteria-table tbody tr.criteria-row[data-row-index="'+rowIndex+'"]');
  var $cell = $row.find('.criteria-status');
  extra = extra || {};
  if (type === 'running') {
    $cell.html('<span class="text-muted"><i class="fa fa-spinner fa-spin"></i> '+__('Calculating')+'...</span>');
  } else if (type === 'ok') {
    $cell.html('<span class="text-status-ok">'+__('Found {0} plans').replace('{0}', extra.count || 0)+'</span>');
  } else if (type === 'empty') {
    $cell.html('<span class="text-status-empty">'+__('Skipped (empty)')+'</span>');
  } else if (type === 'fail') {
    $cell.html('<span class="text-status-fail">'+__('No matching plan')+'</span>');
  } else {
    $cell.html('<span class="text-status-empty">'+__('Not filtered')+'</span>');
  }
}

function selectPlan(idx){
  if (idx < 0 || idx >= candidates.length) return;
  selectedIdx = idx;

  $('#plans-table tbody tr').removeClass('selected');
  $('#plans-table tbody tr[data-idx="'+ idx +'"]').addClass('selected');

  // 使用当前行的操作点
  var op = currentOp || { flow: 0, pressure: 0 };

  var $box = $('#charts-box');
  $box.css('visibility','hidden').show();

  disposeCharts();

  requestAnimationFrame(function(){
    var item = candidates[idx];

    chartPQ = drawPQ('#chart-pq', item.pq_single, item.pq_wall, op);
    chartPower = drawPower('#chart-power', item.power_single, item.power_wall, op.flow);

    $box.css('visibility','visible');
    if (chartPQ)    chartPQ.resize();
    if (chartPower) chartPower.resize();
  });

  $('html,body').stop(true).animate({ scrollTop: $('#plans-box').offset().top - 100 }, 200);
}

function initFormDefaults() {
  var qp = getQueryParams();
  var v = $.extend({}, DEFAULTS, {
    fan_type: (qp.fan_type || qp.type || DEFAULTS.fan_type).toUpperCase(),
    width:    qp.width,
    height:   qp.height,
    airflow:  qp.airflow,
    pressure: qp.pressure,
    controller_location: (qp.controller_location || qp.controller || DEFAULTS.controller_location),
    redundancy: qp.redundancy || DEFAULTS.redundancy
  });

  // Fan type
  $('input[name="fan_type"][value="'+ v.fan_type +'"]').prop('checked', true).trigger('change');

  $('#project_code').val(qp.project_code || '');
  $('#project_name').val(qp.project_name || '');

  // 给第 1 行填默认值
  var $row0 = $('#criteria-table tbody tr.criteria-row').first();
  if ($row0.length) {
    $row0.find('.input-width').val(v.width || '');
    $row0.find('.input-height').val(v.height || '');
    $row0.find('.input-airflow').val(v.airflow || '');
    $row0.find('.input-pressure').val(v.pressure || '');
    $row0.find('.input-controller').val(v.controller_location || '');
    $row0.find('.input-redundancy').val(v.redundancy || '');
  }

  if (qp.autorun == '1' || qp.auto == '1') {
    $('#configure-btn').trigger('click');
  }
}

function switchRowView(rowIndex) {
  var data = batchResults[rowIndex];
  if (!data || !data.candidates || !data.candidates.length) {
    // 行还没计算或没有任何方案，什么都不做
    return;
  }

  currentRowIndex = rowIndex;
  candidates = data.candidates;
  selectedIdx = -1;

  // 高亮参数行
  $('#criteria-table tbody tr.criteria-row').removeClass('selected');
  $('#criteria-table tbody tr.criteria-row[data-row-index="'+rowIndex+'"]').addClass('selected');

  // 更新当前操作点（用于画 OP 点）
  currentOp = {
    flow: Number(data.params.airflow || 0),
    pressure: Number(data.params.pressure || 0)
  };

  $('#result-box').empty();
  renderPlansTable(candidates);

  // 选默认“最优方案”
  var best = 0, bestKey = Number.MAX_VALUE, bestCfg = Number.MAX_VALUE, bestPow = Number.MAX_VALUE;
  candidates.forEach(function(it,i){
    var k1 = Number(it.qty)||1e9;
    var k2 = Number(it.qty_config)||1e9;
    var k3 = Number(it.run_power_kw)||1e9;
    if (k1<bestKey || (k1===bestKey && (k2<bestCfg || (k2===bestCfg && k3<bestPow)))){
      best=i; bestKey=k1; bestCfg=k2; bestPow=k3;
    }
  });
  selectPlan(best);
}


$(function(){
  // 初始化 5 行空行
  var $tbody = $('#criteria-table tbody');
  $tbody.empty();
  for (var i = 0; i < 5; i++) {
    addCriteriaRow();
  }

  // 新增一行按钮
  $('#btn-add-row').on('click', function(){
    addCriteriaRow();
  });

  // 点击参数行：如果该行已经有结果，则切换到该行的方案表格
$('#criteria-table').on('click', 'tr.criteria-row', function(){
  var rowIndex = Number($(this).data('row-index'));
  var data = batchResults[rowIndex];

  // 如果这一行还没有跑过计算，或者没有候选方案，就不切换视图，也不提示
  if (!data || !data.candidates || !data.candidates.length) {
    return;
  }

  switchRowView(rowIndex);
});


  // 其它初始化（fan_type、url默认值等）
  initFormDefaults();
});

/* ------------ filter (batch) ------------ */
$('#configure-btn').off('click').on('click', function(){
  var $rows = $('#criteria-table tbody tr.criteria-row');

  batchResults = {};
  currentRowIndex = null;
  candidates = [];
  selectedIdx = -1;
  disposeCharts();
  $('#plans-box').empty();
  $('#charts-box').hide();
  $('#result-box').html(
    '<div class="text-center text-muted" style="padding:40px 0;">' +
      '<i class="fa fa-spinner fa-spin"></i> ' +
      __('Calculating plans...') +
    '</div>'
  );

  var tasks = [];
  $rows.each(function(){
    var $tr = $(this);
    var p = getRowParams($tr);
    if (isRowEmpty(p)) {
      updateRowStatus(p.rowIndex, 'empty');
      return;
    }
    tasks.push(p);
  });

  if (!tasks.length) {
    $('#result-box').html(
      '<div class="alert alert-warning" style="margin-top:10px;">' +
        __('Please fill in at least one row') +
      '</div>'
    );
    return;
  }

  var projectCode = $('#project_code').val();
  var projectName = $('#project_name').val();
  var fanType = $('input[name="fan_type"]:checked').val();
  var voltage = $('input[name="voltage"]:checked').val(); // 若页面没有，可为空

  var i = 0;
  function runNext() {
    if (i >= tasks.length) {
      // 所有行处理完
      $('#result-box').empty();

      var firstRowWithData = null;
      tasks.forEach(function(p){
        var br = batchResults[p.rowIndex];
        if (!firstRowWithData && br && br.candidates && br.candidates.length) {
          firstRowWithData = p.rowIndex;
        }
      });

      if (firstRowWithData == null) {
        $('#result-box').html('<div class="alert alert-warning">'+__('No matching fan model found.')+'</div>');
      } else {
        switchRowView(firstRowWithData);
        (window.Layer && Layer.msg) ? Layer.msg(__('Calculation succeeded'), {icon:1}) : 0;
      }
      return;
    }

    var p = tasks[i++];
    updateRowStatus(p.rowIndex, 'running');

    // 允许风量/静压为空，没有的话传 0（后端按你的规则解释）
    var airflow  = p.airflow  === '' ? 0 : p.airflow;
    var pressure = p.pressure === '' ? 0 : p.pressure;

    var paramsAjax = {
      fan_type: fanType,
      width: p.width,
      height: p.height,
      airflow: airflow,
      pressure: pressure,
      power: p.power,   // 新增字段，后端自行处理
      voltage: voltage,
      controller_location: p.controller_location || 'inside',
      project_code: projectCode,
      project_name: projectName,
      device_code: p.device_code,
      redundancy: p.redundancy
    };

    Fast.api.ajax({ url:'fan/configure', data: paramsAjax }, function(res){
      var list = res.candidates || [];
      batchResults[p.rowIndex] = { params: p, candidates: list };
      if (list.length) {
        updateRowStatus(p.rowIndex, 'ok', { count: list.length });
      } else {
        updateRowStatus(p.rowIndex, 'fail');
      }
      runNext();
      return false;
    }, function(){
      batchResults[p.rowIndex] = { params: p, candidates: [] };
      updateRowStatus(p.rowIndex, 'fail');
      runNext();
      return false;
    });
  }

  runNext();
});

// ===================== 20251119 ==========

/* ====== 4) 初始化：默认值 + URL 覆盖 ====== */
function initFormDefaults32() {
  var qp = getQueryParams();
  // 允许从 URL 覆盖默认值：?fan_type=CTF&width=3000&...
  var v = $.extend({}, DEFAULTS, {
    fan_type: (qp.fan_type || qp.type || DEFAULTS.fan_type).toUpperCase(),
    width:    qp.width,
    height:   qp.height,
    airflow:  qp.airflow,
    pressure: qp.pressure,
    controller_location: (qp.controller_location || qp.controller || DEFAULTS.controller_location),
    redundancy: qp.redundancy || DEFAULTS.redundancy
  });

  // Fan type
  $('input[name="fan_type"][value="'+ v.fan_type +'"]').prop('checked', true).trigger('change');

  // Controller
  $('input[name="controller_location"][value="'+ v.controller_location +'"]').prop('checked', true);

  // Redundancy
  $('#redundancy').val(v.redundancy);

  // Opening size / airflow / pressure
  setNumberWithRange('width',    'width-range',    v.width);
  setNumberWithRange('height',   'height-range',   v.height);
  setNumberWithRange('airflow',  'airflow-range',  v.airflow);
  setNumberWithRange('pressure', 'pressure-range', v.pressure);

  // 如果希望自动计算，可在 URL 加 autorun=1
  if (qp.autorun == '1' || qp.auto == '1') {
    $('#configure-btn').trigger('click');
  }
}

/* ====== 5) 页面就绪后执行 ====== 
$(function(){
  // 你的事件绑定/表格初始化之后执行
  initFormDefaults();
});
*/
/* ------------ toolbar for current plan ------------ */
function currentPlan(){ return (selectedIdx>=0 && selectedIdx<candidates.length)? candidates[selectedIdx] : null; }

/* =======================================================================
 * 工具：简单转义 HTML
 * ======================================================================= */
function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/* =======================================================================
 * 内部算法：在给定开孔尺寸下，寻找 rows/cols 布局（通用，用于 AHU / CTF）
 * n            = 配置台数 (qty_config)
 * openingWmm   = 开孔宽 (mm)
 * openingHmm   = 开孔高 (mm)
 * pitchXmm     = 水平方向中心距 (mm)
 * pitchYmm     = 垂直方向中心距 (mm)
 * 返回：{ rows, cols, usedWmm, usedHmm } 或 null
 * ======================================================================= */
function findBestGridForOpening(n, openingWmm, openingHmm, pitchXmm, pitchYmm) {
  if (!n || !openingWmm || !openingHmm || !pitchXmm || !pitchYmm) return null;

  var best = null;
  var openArea = openingWmm * openingHmm;

  for (var rows = 1; rows <= n; rows++) {
    var cols = Math.ceil(n / rows);

    // 方案 1：宽 = cols * pitchX, 高 = rows * pitchY
    var w1 = cols * pitchXmm;
    var h1 = rows * pitchYmm;
    if (w1 <= openingWmm + 1e-6 && h1 <= openingHmm + 1e-6) {
      var waste1 = openArea - w1 * h1;
      if (!best || waste1 < best.waste) {
        best = {
          rows: rows,
          cols: cols,
          usedWmm: w1,
          usedHmm: h1,
          waste: waste1,
          pitchXmm: pitchXmm,
          pitchYmm: pitchYmm
        };
      }
    }

    // 方案 2：旋转 90° （宽用 pitchY，高用 pitchX）
    var w2 = cols * pitchYmm;
    var h2 = rows * pitchXmm;
    if (w2 <= openingWmm + 1e-6 && h2 <= openingHmm + 1e-6) {
      var waste2 = openArea - w2 * h2;
      if (!best || waste2 < best.waste) {
        best = {
          rows: rows,
          cols: cols,
          usedWmm: w2,
          usedHmm: h2,
          waste: waste2,
          pitchXmm: pitchYmm,  // 注意这里：宽方向用 pitchY
          pitchYmm: pitchXmm   // 高方向用 pitchX
        };
      }
    }
  }

  if (!best) return null;
  return {
    rows: best.rows,
    cols: best.cols,
    usedWmm: best.usedWmm,
    usedHmm: best.usedHmm,
    pitchXmm: best.pitchXmm,
    pitchYmm: best.pitchYmm
  };
}
/* =======================================================================
 * 计算风机墙布局（前端版本，与后端规则一致）
 * sel         = 当前选中的 candidate（后端 configure 返回的一条）
 * openingWmm  = 开孔宽 (表单 width，单位 mm)
 * openingHmm  = 开孔高 (表单 height，单位 mm)
 * 返回：{ width_px, height_px, fanW_px, fanH_px, centers:[{x,y}...], ... }
 * ======================================================================= */
function computeFanWallLayout(sel, openingWmm, openingHmm) {
  if (!sel) {
    return { error: __('No selected plan') };
  }

  openingWmm = Number(openingWmm || 0);
  openingHmm = Number(openingHmm || 0);
  if (!openingWmm || !openingHmm) {
    return { error: __('Please fill in opening size (width & height)') };
  }

  // 配置台数
  var n = Number(sel.qty_config || sel.qty || 0);
  if (!n || n <= 0) {
    return { error: __('No configured units in this plan') };
  }

  // 风机类型：优先 candidate 中的 fan_type，没有则读当前表单
  var fanType = (sel.fan_type ||
                 $('input[name="fan_type"]:checked').val() ||
                 '').toUpperCase();
  if (!fanType) fanType = 'AHU';

  // 基础尺寸（mm）
  var Dmm  = Number(sel.impeller_diameter || sel.impellerDiameter || 0);   // 叶轮直径
  var Lmm  = Number(sel.outline_length    || sel.outlineLength    || 0);   // 外形长度
  var Wfmm = Number(sel.outline_width     || sel.outlineWidth     || 0);   // 外形宽度

  // 如果后端已经算好布局间距，就优先用后端的
  var pitchXmm = Number(sel.layout_pitch_x_mm || 0);
  var pitchYmm = Number(sel.layout_pitch_y_mm || 0);

  if (!pitchXmm || !pitchYmm) {
    if (fanType === 'AHU') {
      // AHU：中心距 = 1.8×D（左右、上下都一样）
      if (!Dmm) {
        return { error: __('Missing impeller diameter for layout') };
      }
      var pitch = 1.8 * Dmm;
      pitchXmm = pitch;
      pitchYmm = pitch;
    } else {
      // CTF：按外形尺寸直接排布
      if (!Lmm || !Wfmm) {
        return { error: __('Missing outline size for layout') };
      }
      pitchXmm = Lmm;
      pitchYmm = Wfmm;
    }
  }

  // 行列数：后端如果已给 rows/cols，就用后端；否则前端自己算一遍
  var rows = Number(sel.rows || 0);
  var cols = Number(sel.cols || 0);

  var needRecompute =
    !rows || !cols ||
    rows * cols < n ||
    (pitchXmm * cols > openingWmm + 1e-6) ||
    (pitchYmm * rows > openingHmm + 1e-6);

  var usedWmm, usedHmm;

  if (needRecompute) {
    var best = findBestGridForOpening(n, openingWmm, openingHmm, pitchXmm, pitchYmm);
    if (!best) {
      if (fanType === 'AHU') {
        return {
          error: __('Opening size is too small for {0} units with 1.8×D spacing.')
            .replace('{0}', n)
        };
      } else {
        return {
          error: __('Opening size is too small for {0} units with outline size.')
            .replace('{0}', n)
        };
      }
    }
    rows     = best.rows;
    cols     = best.cols;
    pitchXmm = best.pitchXmm;
    pitchYmm = best.pitchYmm;
    usedWmm  = best.usedWmm;
    usedHmm  = best.usedHmm;
  } else {
    usedWmm = cols * pitchXmm;
    usedHmm = rows * pitchYmm;
  }

  // 至少保证开孔尺寸不比使用尺寸小（避免反向缩放）
  var drawWmm = Math.max(openingWmm, usedWmm);
  var drawHmm = Math.max(openingHmm, usedHmm);

  // 画布基准：让较大边约等于 456px
  var BASE_PX = 456;
  var scale   = BASE_PX / Math.max(drawWmm, drawHmm);

  var canvasW = Math.max(220, Math.round(drawWmm * scale));
  var canvasH = Math.max(220, Math.round(drawHmm * scale));

  var usedWpx = usedWmm * scale;
  var usedHpx = usedHmm * scale;

  // 把风机墙整体居中到画布里
  var offsetX = (canvasW - usedWpx) / 2;
  var offsetY = (canvasH - usedHpx) / 2;

  // === 单台风机图标宽高 ===
  var fanW_px, fanH_px;
  if (fanType === 'AHU') {
    // AHU：完全按照 1.8×D 的中心距来画，每个图标占 cell 的 ~80%
    // 这样左右 / 上下都会显出间隙，不会出现只左右有缝、上下贴死
    var cellPx  = pitchXmm * scale;      // 一个中心距对应的像素
    var iconPx  = cellPx * 0.8;          // 留 20% 空隙
    fanW_px = fanH_px = Math.max(24, Math.min(iconPx, 140));
  } else {
    // CTF：用外形尺寸等比缩放
    fanW_px = Lmm ? (Lmm * scale) : (pitchXmm * 0.8 * scale);
    fanH_px = Wfmm ? (Wfmm * scale) : (pitchYmm * 0.8 * scale);
    fanW_px = Math.max(24, Math.min(fanW_px, 140));
    fanH_px = Math.max(24, Math.min(fanH_px, 140));
  }

  // 计算每台风机中心坐标
  var centers = [];
  var count   = 0;
  for (var r = 0; r < rows; r++) {
    for (var c = 0; c < cols; c++) {
      if (count >= n) break;
      var cx_mm = (c + 0.5) * pitchXmm;
      var cy_mm = (r + 0.5) * pitchYmm;
      centers.push({
        x: offsetX + cx_mm * scale,
        y: offsetY + cy_mm * scale
      });
      count++;
    }
  }

  return {
    width_px: canvasW,
    height_px: canvasH,
    fanW_px: fanW_px,
    fanH_px: fanH_px,
    centers: centers,

    // 展示用信息
    rows: rows,
    cols: cols,
    fan_type: fanType,
    opening_width_mm: openingWmm,
    opening_height_mm: openingHmm,
    used_width_mm: usedWmm,
    used_height_mm: usedHmm,
    pitch_x_mm: pitchXmm,
    pitch_y_mm: pitchYmm,
    qty: n
  };
}


/* =======================================================================
 * 根据布局生成风机墙示意图的 HTML
 * sel    = 当前方案（candidates 里的 one row）
 * layout = 上面 computeFanWallLayout 的返回值
 * 返回：{ width, height, html }
 * ======================================================================= */
function buildFanWallLayoutHtml(sel, layout) {
  if (!layout || !layout.centers || !layout.centers.length) {
    return {
      width: 480,
      height: 200,
      html:
        '<div style="padding:16px;font-size:14px;color:#c00;">' +
        escapeHtml(__('No layout data')) +
        '</div>'
    };
  }

  var w = layout.width_px;
  var h = layout.height_px;
  var fanW = layout.fanW_px;
  var fanH = layout.fanH_px;

  // 头部信息
  var summaryHtml =
    '<div style="margin-bottom:10px;font-size:13px;line-height:1.6;">' +
      '<div>' + escapeHtml(__('Fan model')) + ': ' +
        '<strong>' + escapeHtml(sel.fan_model || '') + '</strong>' +
      '</div>' +
      '<div>' + escapeHtml(__('Qty (configured)')) + ': ' +
        escapeHtml(layout.qty) +
      '</div>' +
      '<div>' + escapeHtml(__('Opening size')) + ': ' +
        escapeHtml(layout.opening_width_mm) + ' × ' +
        escapeHtml(layout.opening_height_mm) + ' mm' +
      '</div>' +
      '<div>' + escapeHtml(__('Used size')) + ': ' +
        Math.round(layout.used_width_mm) + ' × ' +
        Math.round(layout.used_height_mm) + ' mm' +
      '</div>' +
    '</div>';

  // 画布：边框表示开孔边界
  var canvasHtml =
    '<div style="' +
      'position:relative;' +
      'border:1px solid #ddd;' +
      'background:#fafafa;' +
      'box-sizing:border-box;' +
      'width:' + w + 'px;' +
      'height:' + h + 'px;' +
      'overflow:hidden;' +
    '">';

  // 单台风机图标：使用 fanwall_unit.png 作为背景图
  layout.centers.forEach(function (c, idx) {
    var left = c.x - fanW / 2;
    var top  = c.y - fanH / 2;
    canvasHtml +=
      '<div class="fanwall-cell" style="' +
        'position:absolute;' +
        'left:' + left + 'px;' +
        'top:' + top + 'px;' +
        'width:' + fanW + 'px;' +
        'height:' + fanH + 'px;' +
        'box-sizing:border-box;' +
      '">' +
        '<div class="fanwall-cell-label">' + (idx + 1) + '</div>' +
      '</div>';
  });

  canvasHtml += '</div>';

  var html =
    '<div style="padding:16px 20px 20px 20px;">' +
      summaryHtml +
      canvasHtml +
    '</div>';

  return {
    width: w,
    height: h,
    html: html
  };
}



$('#btn-save-selected').on('click', function(){
  var sel = currentPlan(); if(!sel) return;

  var must = {
    project_code: $('#project_code').val(),
    project_name: $('#project_name').val()
  };
  if(!must.project_code || !must.project_name){
    (window.Layer&&Layer.msg)?Layer.msg(__('Please fill in Project Code / Project Name first')):alert(__('Please fill in Project Code / Project Name first'));
    return;
  }

  var rowData = batchResults[currentRowIndex] ? batchResults[currentRowIndex].params : null;
  if (!rowData) {
    (window.Layer&&Layer.msg)?Layer.msg(__('No active row')):0;
    return;
  }

  must.device_code = rowData.device_code || '';

  var selection = $.extend({}, must, {
    fan_type: $('input[name="fan_type"]:checked').val(),
    target_airflow: rowData.airflow,
    target_pressure: rowData.pressure,
    install_w: rowData.width,
    install_h: rowData.height,
    redundancy: rowData.redundancy,
    product_id: sel.product_id, product_model: sel.fan_model,
    qty_exact: sel.qty_exact, qty_base: sel.qty, qty_config: sel.qty_config,
    rows: sel.rows, cols: sel.cols,
    run_power_total_kw: sel.run_power_kw, run_speed_rpm: sel.run_speed,
    work_efficiency_pct: sel.efficiency_pct,
    rated_power_total_kw: sel.rated_power_total_kw, rated_current_total_a: sel.rated_current_total_a,
    nominal_flow_total: sel.nominal_flow_total, nominal_pressure: sel.nominal_pressure,
    single_rated_power_kw: sel.single_rated_power_kw, single_rated_current_a: sel.single_rated_current_a,
    single_work_power_kw: sel.single_work_power_kw, single_work_current_a: sel.single_work_current_a,
    redundancy_ratio_pct: sel.redundancy_ratio_pct,
    curves_json: JSON.stringify({
      pq_single: sel.pq_single, pq_wall: sel.pq_wall,
      power_single: sel.power_single, power_wall: sel.power_wall
    })
  });

  // 前端本地先写入（避免后端返回“全部方案”导致全部显示）
  var savedItem = $.extend({_sid: genSid()}, selection);
  savedLocal.push(savedItem);
  persistSaved();
  renderSaved(savedLocal);

  // 后端保存（仅一条），可带一个标记由你服务端识别
  Fast.api.ajax({ url:'fan/saveSelection', data:{ selection: selection, only:1 } }, function(res){
    // 如果后端返回 id，则补齐
    if(res && res.item && res.item.id){
      savedItem.id = res.item.id;
      persistSaved();
    }
    (window.Layer&&Layer.msg)?Layer.msg(__('Saved to the right list'),{icon:1}):0;
  });
});

$(document).on('click', '#fanwall-saved .saved-note', function(e){
  // 点到右上角删除按钮时，不触发详情
  if ($(e.target).closest('.saved-note-remove').length) return;

  var sid = $(this).data('sid');
  var found = null;
  for (var i=0;i<savedLocal.length;i++){
    if (savedLocal[i]._sid === sid){ found = savedLocal[i]; break; }
  }
  if (found) {
    openSavedDetail(found);
  }
});

$(document).on('click', '#fanwall-saved .saved-note-remove', function(e){
  e.stopPropagation();
  var sid = $(this).data('sid');
  // 前端删除
  savedLocal = savedLocal.filter(function(it){ return it._sid !== sid; });
  persistSaved();
  renderSaved(savedLocal);

  // 后端删除（占位，若有 res.id 可发送 id）
  Fast.api.ajax({ url:'fan/deleteSelection', data:{ sid: sid } }, function(){});
});

      $('#btn-export-selected').on('click', function(){
        Fast.api.ajax({url:'fan/exportExcel', data:{}}, function(){
          (window.Layer&&Layer.msg)?Layer.msg(__('Export task created (placeholder function)')):0;
        });
      });

// 点击“风机墙示意图”按钮
$('#btn-layout-selected').off('click').on('click', function () {
  var sel = currentPlan();    // 当前选中的 candidate
  console.log(sel);
  if (!sel) {
    if (window.Layer && Layer.msg) {
      Layer.msg(__('Please select a plan first'));
    } else {
      alert(__('Please select a plan first'));
    }
    return;
  }

var rowData = batchResults[currentRowIndex] ? batchResults[currentRowIndex].params : null;
var openingW = Number(rowData && rowData.width || 0);
var openingH = Number(rowData && rowData.height || 0);

  if (!openingW || !openingH) {
    if (window.Layer && Layer.msg) {
      Layer.msg(__('Please fill in opening size (width & height)'));
    } else {
      alert(__('Please fill in opening size (width & height)'));
    }
    return;
  }

  // 只新增这两步：计算排布 + 生成示意图 HTML
  var layout = computeFanWallLayout(sel, openingW, openingH);
  if (layout && layout.error) {
    if (window.Layer && Layer.msg) {
      Layer.msg(layout.error);
    } else {
      alert(layout.error);
    }
    return;
  }

  var view = buildFanWallLayoutHtml(sel, layout);

  // 和你之前一样，用 layer 打弹窗（如果有）
  var L = window.Layer || window.layer;
  if (L && L.open) {
    L.open({
      type: 1,
      title: __('Fan-Wall Layout'),
      area: [
        Math.round(view.width + 80) + 'px',
        Math.round(view.height + 120) + 'px'
      ],
      shadeClose: true,
      content: view.html
    });
  } else {
    // 没有 layer 时兜底，用新窗口打开
    var w = window.open('about:blank');
    w.document.write(view.html);
    w.document.close();
  }
});



      /* ------------ reset ------------ */
$('#btn-reset').on('click', function(){
  $('#project_code').val('');
  $('#project_name').val('');
  var $tbody = $('#criteria-table tbody');
  $tbody.empty();
  for (var i = 0; i < 5; i++) addCriteriaRow();

  batchResults = {};
  currentRowIndex = null;
  candidates = [];
  selectedIdx = -1;

  $('#result-box').html('<div class="alert alert-info" style="margin-top:10px;">'
    + __('Enter the target airflow and static pressure, then click “Filter”. The system calculates unit count with the max VSP curve & interpolation, and plots single/fan-wall PQ and power curves.')
    + '</div>');
  $('#plans-box').empty();
  $('#charts-box').hide();
  disposeCharts();
});

          
    /* ===================== 导出当前方案表格 ===================== */
    $('#btn-export-selected').off('click').on('click', function(){
      if(!candidates || !candidates.length){
        (window.Layer&&Layer.msg)?Layer.msg(__('No data to export')):alert(__('No data to export'));
        return;
      }
      // 仅把表格里展示的字段发给后端
      var rows = candidates.map(function(it){
        return {
          fan_model: it.fan_model,
          qty_exact: it.qty_exact,
          qty: it.qty,
          qty_config: it.qty_config,
          run_power_kw: it.run_power_kw,
          run_speed: it.run_speed,
          efficiency_pct: it.efficiency_pct,
          rated_power_total_kw: it.rated_power_total_kw,
          rated_current_total_a: it.rated_current_total_a,
          nominal_flow_total: it.nominal_flow_total,
          nominal_pressure: it.nominal_pressure
        };
      });

      Fast.api.ajax({
        url: 'fan/exportFanWallExcel',
        type: 'POST', 
        data: { rows: JSON.stringify(rows) }
      }, function(res){
        if(res && res.url){
          // 直接下载
          window.location = res.url;
          (window.Layer&&Layer.msg)?Layer.msg(__('Exported')):0;
        }
        return false;
      });
    });
      
    }
  };
  return Controller;
});
