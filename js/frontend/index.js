define(['jquery', 'bootstrap', 'frontend', 'form', 'echarts', 'bootstrap-table', 'bootstrap-table-filter-control', 'bootstrap-table-sticky-header', './settings'], function ($, undefined, Frontend, Form, echarts, undefined, undefined, undefined, UnitSettings) {

	(function ($) {
	  'use strict';
		
		var sprintf = $.fn.bootstrapTable.utils.sprintf;
		var getCurrentHeader = function (that) {
			var header = that.$header;
			if (that.options.height) {
				header = that.$tableHeader;
			}

			return header;
		};

		var getCurrentSearchControls = function (that) {
			var searchControls = 'select, input';
			if (that.options.height) {
				searchControls = 'table select, table input';
			}

			return searchControls;
		};

		var getCursorPosition = function(el) {
			if ($.fn.bootstrapTable.utils.isIEBrowser()) {
				if ($(el).is('input')) {
					var pos = 0;
					if ('selectionStart' in el) {
						pos = el.selectionStart;
					} else if ('selection' in document) {
						el.focus();
						var Sel = document.selection.createRange();
						var SelLength = document.selection.createRange().text.length;
						Sel.moveStart('character', -el.value.length);
						pos = Sel.text.length - SelLength;
					}
					return pos;
				} else {
					return -1;
				}
			} else {
				return -1;
			}
		};

		var setCursorPosition = function (el, index) {
			if ($.fn.bootstrapTable.utils.isIEBrowser()) {
				if(el.setSelectionRange !== undefined) {
					el.setSelectionRange(index, index);
				} else {
					$(el).val(el.value);
				}
			}
		};

		var copyValues = function (that) {
			var header = getCurrentHeader(that),
				searchControls = getCurrentSearchControls(that);

			that.options.valuesFilterControl = [];

			header.find(searchControls).each(function () {
				that.options.valuesFilterControl.push(
					{
						field: $(this).closest('[data-field]').data('field'),
						value: $(this).val(),
						position: getCursorPosition($(this).get(0))
					});
			});
		};

		var setValues = function(that) {
			var field = null,
				result = [],
				header = getCurrentHeader(that),
				searchControls = getCurrentSearchControls(that);

			if (that.options.valuesFilterControl.length > 0) {
				header.find(searchControls).each(function (index, ele) {
					field = $(this).closest('[data-field]').data('field');
					result = $.grep(that.options.valuesFilterControl, function (valueObj) {
						return valueObj.field === field;
					});

					if (result.length > 0) {
						$(this).val(result[0].value);
						setCursorPosition($(this).get(0), result[0].position);
					}
				});
			}
		};
			
		/* ---------- 模板不变 ---------- */
		$.extend($.fn.bootstrapTable.defaults.filterTemplate, {
			range: function (that, field, vis) {
			  return sprintf(
				'<div style="display:flex;gap:4px; margin-top:-2px; width:100%%;visibility:%s">' +
				  '<input type="number" step="any" placeholder="min" class="form-control range-min bootstrap-table-filter-control-%s" style="width:48%%">' +
				  '<input type="number" step="any" placeholder="max" class="form-control range-max bootstrap-table-filter-control-%s" style="width:48%%">' +
				'</div>', vis, field, field);
			}
		});

		/* ---------- 保留 copy / set 光标逻辑 ---------- */
		const copyBase = copyValues,
				setBase  = setValues;

		copyValues = function (that) {
			copyBase.call(this, that);
			getCurrentHeader(that).find('.range-min, .range-max').each(function () {
			  that.options.valuesFilterControl.push({
				field: $(this).closest('[data-field]').data('field') + ($(this).hasClass('range-min') ? '_min' : '_max'),
				value: $(this).val(),
				position: getCursorPosition(this)
			  });
			});
		};

		setValues = function (that) {
			setBase.call(this, that);
			getCurrentHeader(that).find('.range-min, .range-max').each(function () {
			  const $el = $(this),
					field = $el.closest('[data-field]').data('field'),
					//rec = that.options.valuesFilterControl.find(v => v.field === field);
                    role = $(this).hasClass('range-min') ? '_min' : '_max',
                    rec  = that.options.valuesFilterControl.find(v => v.field === field + role);
			  if (rec) {
				$el.val(rec.value);
				setCursorPosition(this, rec.position);
			  }
			});
		};

		// ---------- range 专用 onColumnSearch ---------- 
        // —— 重写 onColumnSearch：保留筛选条件与事件，屏蔽内部 refresh ——
        var BootstrapTable = $.fn.bootstrapTable.Constructor;
        const _oriOCS = BootstrapTable.prototype.onColumnSearch;
        BootstrapTable.prototype.onColumnSearch = function (evt) {
            const $el   = $(evt.currentTarget);
            const field = $el.closest('[data-field]').data('field');
        
            /* ① 保存输入值（对 range-min/max 也各自独立保存，后面第 2 点会继续用到） */
            if (!this.filterColumnsPartial) this.filterColumnsPartial = {};
            const key  = ($el.hasClass('range-min') || $el.hasClass('range-max'))
                         ? field + ($el.hasClass('range-min') ? '_min' : '_max')
                         : field;
            const val  = $.trim($el.val());
            if (val === '') delete this.filterColumnsPartial[key];
            else            this.filterColumnsPartial[key] = val;


            /* 同步值到另一份表头（避免两套 DOM 状态分叉） */
            const inSticky = !!$el.closest('.fix-sticky').length;
            const $otherThead = inSticky ? $('#fan-results-table thead')
                                       : $('.fix-sticky thead');
            if ($otherThead.length) {
                const isRange = $el.hasClass('range-min') || $el.hasClass('range-max');
                const sel = isRange ? ('.' + ($el.hasClass('range-min') ? 'range-min' : 'range-max'))
                                    : ($el.is('select') ? 'select' : 'input');
                const $other = $otherThead.find(`[data-field="${field}"]`).find(sel);
                if ($other.length) $other.val($el.val());
            }
  
            /* ② 触发事件，让我们自己写的 800 ms debounce 去 refresh */
            this.options.pageNumber = 1;
            this.trigger('column-search', field, this.filterColumnsPartial[key]);

        };
        
        // 清空表头 重写
		const _clear_ori = BootstrapTable.prototype.clearFilterControl;
		BootstrapTable.prototype.clearFilterControl = function () {
			_clear_ori.apply(this, arguments);           // 先走官方/原版逻辑

			if (!this.options.filterControl || !this.options.filterShowClear) return;

			// 1) 清空所有 range 输入框
			const header = getCurrentHeader(this);
			header.find('.range-min, .range-max').val('');
            $('.fix-sticky thead').find('.range-min, .range-max, select, input').val(''); // ← 新增 sticky header 清空
            
			// 2) 从 filterColumnsPartial 删掉对应字段，防止立即又被当成 NaN 保存
			if (this.filterColumnsPartial) {
			  for (const k in this.filterColumnsPartial) {
				const col = this.columns[$.fn.bootstrapTable.utils.getFieldIndex(this.columns, k)];
				if (col.filterControl && col.filterControl.toLowerCase() === 'range') {
				  delete this.filterColumnsPartial[k];
				}
			  }
			}

            $.each(this.$header.find('select, input'), function (i, item) {
                item.value = '';
            });

			// 3) 触发一次刷新，让表格回到未过滤状态
			//this.onSearch();
            if (this.options.sidePagination === 'server') {
               /* 借助全局 debounce 逻辑，和 range 输入框保持一致 */
               this.options.pageNumber = 1;                 // 回到第一页
               this.trigger('column-search', 'clear', null);/* → 400 ms 后 refresh */
            } else {
               this.onSearch();                             // 本地表直接过滤
            }
		};
		  
	})(jQuery);
	
    
    // 全局变量定义
    var paramRanges = {
        'air_flow': ori_flow,
        'air_pressure': [1,1000]
    };

    /**
     * 计算 series 中 X/Y 最大值并写回 option 里的轴范围
     * 一律留 10% 头寸，避免数据贴边
     */
    const refreshAxisRange = (option, axis = 'x') => {
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

        //option[axis + 'Axis'][0].max = Math.ceil(maxV * 1.1);    // +10 %
        option[axis + 'Axis'][0].max = +((maxV * 1.1).toFixed(3));    // +10 %
    }
    
    const toFixedValue = (value, unit, num) => {
        if ( typeof num != 'undefined' ) {
            return (value-0).toFixed(num);
        }
        if ( unit == 'm³/s' || unit == 'inH₂O' ) {
            return (value-0).toFixed(3);
        }
        if ( unit == 'm³/h' || unit == 'CFM' || unit == 'Pa' || unit == 'W' ) {
            return (value-0).toFixed(0);
        }
        
        return (value-0).toFixed(2);
    }
    
	window.sliderControls = window.sliderControls || {};

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


	var Controller = {
        
        // 存储原始数据
        originalData: [],
		lastTotal: 0,
		//保持搜索参数
		searchParams : {
			airFlow: null,
			airPressure: null,
			toleranceMin: -30,
			toleranceMax: 30
		},

		// PQ 曲线相关属性 1
        pqCurveChart: null,
        pqCurveData: [],
        fanVsp: {},
        pqCurveGroupData: [],
        pqCurveFanIds: [],
        highlightedModel: null,
        pqClickBound: false,

        // 初始化 PQ 曲线图表
        initPQCurveChart: function () {
            var chartDom = document.getElementById('pq-curve-chart');
            if (!chartDom) return;

            Controller.pqCurveChart = echarts.init(chartDom, null, { renderer: 'canvas' });
            
            var option = {
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
                    data: [],
                    type: 'scroll',
                    bottom: 0
                },
                grid: {
                    left: 40,
                    right: '4%',
                    bottom: '15%',
                    top: '8%',
                    containLabel: true
                },
                xAxis: {
                    type: 'value',
                    name: __('Air Flow') + ' (' + Controller.getFlowUnit() + ')',
                    nameLocation: 'middle',
                    nameGap: 30,
					axisPointer: {
						snap: false,  // 坐标轴指示器是否自动吸附到点上
						label: {
							formatter: function (params) {
								return (params.value - 0).toFixed(2) + ' ' + Controller.getFlowUnit();
							}
						}
					}
                },
                yAxis: {
                    type: 'value',
                    name: __('Static Pressure') + ' (' + Controller.getPressureUnit() + ')',
                    nameLocation: 'middle',
                    nameGap: 40,
					axisPointer: {
						snap: false,  // 坐标轴指示器不自动吸附到点上
						label: {
							formatter: function (params) {
								return (params.value - 0).toFixed(2) + ' ' + Controller.getPressureUnit();
							}
						}
					}
                },
                series: []
            };
            
            Controller.pqCurveChart.setOption(option);

            // 响应窗口大小变化
            window.addEventListener('resize', function () {
                if (Controller.pqCurveChart) {
                    Controller.pqCurveChart.resize();
                }
            });
            
            // 监听单位设置变化
            $(document).on('units:changed', function (settings, oldsettings) {
                // 更新单位设置
                Controller.updatePQCurveUnits();
                
                // 更新图表和数据
                if ( Controller.pqCurveChart ) {
                    let option = Controller.pqCurveChart.getOption();
                    if ( option.series.length ) {
                        Controller.processPQData( Controller.pqCurveData );
                    }
                } 
                
                let lang = 'en_US';
                if (Config.language === 'ko') lang = 'ko-KR';
                if (Config.language === 'zh-cn') lang = 'zh-CN';
                if (Config.language === 'es') lang = 'es-ES';
                if (Config.language === 'ru') lang = 'ru-RU';
                $('#fan-results-table').bootstrapTable('refreshOptions', { locale: lang });                
            });
			
        },
        
        // 只在整个页面生命周期里绑定一次
        bindPQClickEvent: function  () {
            if (!Controller.pqCurveChart || Controller.pqClickBound) return;
            Controller.pqClickBound = true;
            console.log('bindPQClickEvent');
            const getFanIdByModel = (model) => {
                const row = Controller.originalData.find(r => r.fan_model === model);
                return row ? row.id : null;     
            };
            Controller.pqCurveChart.on('click', function (params) {
                console.log(params);
                // 仅响应点击曲线或数据点，忽略坐标轴/空白
                if (params.componentType !== 'series') return;

                // ───── 取标识 ─────
                const fanIdOrModel = '/id/' + getFanIdByModel(params.seriesName);

                // ───── 跳转 ─────
                const url = Frontend.api.fixurl('fan/detail') + fanIdOrModel;
                // 同窗口跳转就用 location.href = url
                window.open(url, '_blank');        // 新标签打开
            });
            
            Controller.pqCurveChart.getZr().on('click', e=>{
                console.log('ZR clicked', e);
            });
        },

        
        // 获取流量单位
        getFlowUnit: function () {
            return UnitSettings.getFlowUnit() || 'm³/h';
        },
        
        // 获取压力单位
        getPressureUnit: function () {
            return UnitSettings.getPressureUnit() || 'Pa';
        },
        
        // 更新 PQ 曲线单位
        updatePQCurveUnits: function () {
            if (!Controller.pqCurveChart) return;
            
            // 更新坐标轴单位
            Controller.pqCurveChart.setOption({
                xAxis: {
                    name: __('Air Flow') + ' (' + Controller.getFlowUnit() + ')'
                },
                yAxis: {
                    name: __('Static Pressure') + ' (' + Controller.getPressureUnit() + ')'
                }
            });
            
            // 重新加载当前表格中显示的风机的 PQ 数据
            //Controller.loadTableFansPQData();
            //Controller.scheduleLoadPQ();
        },
		
        // 加载当前表格中显示的风机的 PQ 数据
        loadTableFansPQData: function () {
            var _table = $('#fan-results-table');
            if (!_table.length) return;
            
			// 获取当前表格中的数据
			var tableData = _table.bootstrapTable('getData', {useCurrentPage: true});
        
			console.log('Raw table data:', tableData);
			
			// 如果表格没有数据，直接返回
			if (!tableData || !tableData.length) {
				// 先清除图表
				Controller.pqCurveChart.clear();
                $('#pq-curve-container').fadeOut();
				return;
			}
			
            // 获取所有风机 ID
            var fanIds = tableData.map(function (item) {
                return item.id;
            });
            
            var use_chosenvsp = false;
            tableData.forEach(function (item) {
                Controller.fanVsp[item.id] = item.chosen_vsp;
            });
            
			console.log('Loading PQ data for fan IDs:', fanIds);
            // 加载这些风机的 PQ 数据
            $.ajax({
                url: Frontend.api.fixurl('fan/getMultipleFansPQData'),
                type: 'post',
                dataType: 'json',
                data: { fan_ids: fanIds.join(',') },
                success: function (ret) {
                    if (ret.code === 1 && ret.data) {
                        // 处理 PQ 数据
                        Controller.processPQData(ret.data);
                    } else {
                        Layer.msg(ret.msg || __('Failed to get PQ data'));
                    }
                },
                error: function () {
                    Layer.msg(__('Network error, please try again'));
                }
            });
        },
        
        // 处理 PQ 数据
        processPQData: function (data) {
	
			// 清空图表
			if (Controller.pqCurveChart) {
				// 先清除图表
				Controller.pqCurveChart.clear();
                
                //Controller.pqClickBound = false;
				
				// 重新设置基本配置
				Controller.pqCurveChart.setOption({
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
                        // 不显示默认的 tooltip 框
                        showContent: false
                    },
                
					legend: { 
						data: [],
						type: 'scroll',
						bottom: 0
					},
					grid: {
						left: 30,
						right: '4%',
						bottom: '15%',
						top: '8%',
						containLabel: true
					},
					xAxis: {
						type: 'value',
						name: __('Air Flow') + ' (' + Controller.getFlowUnit() + ')',
						nameLocation: 'middle',
						nameGap: 30,
						axisPointer: {
							snap: false,
							label: {
								formatter: function (params) {
									return (params.value - 0).toFixed(2) + ' ' + Controller.getFlowUnit();
								}
							}
						}
					},
					yAxis: {
						type: 'value',
						name: __('Static Pressure') + ' (' + Controller.getPressureUnit() + ')',
						nameLocation: 'middle',
						nameGap: 40,
						axisPointer: {
							snap: false,
							label: {
								formatter: function (params) {
									return (params.value - 0).toFixed(2) + ' ' + Controller.getPressureUnit();
								}
							}
						}
					},
					series: []
				});
			}
			
			// 重置数据
			Controller.pqCurveData = [];
			
			// 如果没有数据，直接返回
			if (!data || !data.length) {
                $('#pq-curve-container').fadeOut();
				return;
			} else {
                $('#pq-curve-container').fadeIn();
            }
		
                    
           // === 1) 构建 fanId -> vsp -> points 的分组，并收集每台风机的 vsp 列表 ===
            var groupsByFanVsp = {};   // { [fanId]: { [vsp]: [[flow, pressure], ...] } }
            var vspListByFan   = {};   // { [fanId]: [vsp1, vsp2, ...] }

            data.forEach(function (item) {
                var fanId    = parseInt(item.fan_product_id);
                var vsp      = parseFloat(item.vsp);
                var flowRaw  = parseFloat(item.air_flow_m3h);
                var presRaw  = parseFloat(item.air_pressure);

                if (isNaN(fanId) || isNaN(vsp) || isNaN(flowRaw) || isNaN(presRaw)) return;

                // 坐标轴单位转换（与图表一致）
                var flow = Controller.convertFlow(flowRaw);
                var pres = Controller.convertPressure(presRaw);

                if (!groupsByFanVsp[fanId]) groupsByFanVsp[fanId] = {};
                if (!groupsByFanVsp[fanId][vsp]) groupsByFanVsp[fanId][vsp] = [];
                //groupsByFanVsp[fanId][vsp].push([flow, pres]);
                
                var amend = parseFloat(item.air_pressure_amend);
                groupsByFanVsp[fanId][vsp].push([flow, pres, amend]);

                (vspListByFan[fanId] = vspListByFan[fanId] || []).push(vsp);
            });
            console.log('groupsByFanVsp',groupsByFanVsp)

            // vsp 去重+升序
            Object.keys(vspListByFan).forEach(function (fid) {
                var arr = Array.from(new Set(vspListByFan[fid])).sort(function (a, b) { return a - b; });
                vspListByFan[fid] = arr;
            });

            // === 2) 计算用户输入的容差窗口（与图表相同单位） ===
            var targetFlow     = Controller.convertFlow(Controller.searchParams.airFlow || 0);
            var targetPressure = Controller.convertPressure(Controller.searchParams.airPressure || 0);
            var tolMin = parseFloat(Controller.searchParams.toleranceMin || 0) / 100;
            var tolMax = parseFloat(Controller.searchParams.toleranceMax || 0) / 100;

            var flowL = targetFlow * (1 + tolMin);
            var flowH = targetFlow * (1 + tolMax);
            var presL = targetPressure * (1 + tolMin);
            var presH = targetPressure * (1 + tolMax);

            // === 3) 为每台风机选择“正确的 vsp 曲线” ===
            var fanGroups = {};      // { fanId: [[flow, pres] ...] } —— 最终用于画图
            var fanIds    = [];
            Controller.pqChosenVspMap = {};  // 可视化/调试：记录每台风机最终使用的 vsp

            Object.keys(groupsByFanVsp).forEach(function (fidStr) {
                var fanId = parseInt(fidStr);
                var vsps  = vspListByFan[fanId];      // 升序
                if (!vsps || !vsps.length) return;
                
                var chosenVsp = null;

                 // 直接使用可用的
                if ( typeof Controller.fanVsp[fanId] != 'undefined' && Controller.fanVsp[fanId] != null ) { 
                    chosenVsp = Controller.fanVsp[fanId];
                } else {
                    // 查找一些vsp
                    // 跳过最小 vsp
                    var candidates = vsps.slice(1);       // 没有第二条时，candidates 为空

                    // 在候选 vsp 中，找“最小且命中窗口”的 vsp
                    /*
                    for (var i = 0; i < candidates.length; i++) {
                        var v = candidates[i];
                        var pts = groupsByFanVsp[fanId][v] || [];
                        var hit = pts.some(function (p) {
                            return p[0] >= flowL && p[0] <= flowH && p[1] >= presL && p[1] <= presH;
                        });
                        if (hit) { chosenVsp = v; break; }
                    }
                    */
                    // 兜底：没有任何非最小 vsp 命中 → 用“次小 vsp”；再不行（只有一条曲线）就用唯一那条
                    if (chosenVsp === null) {
                        if (candidates.length) {
                            chosenVsp = candidates[candidates.length-1];   // 最大
                        } else {
                            chosenVsp = vsps[0];         // 只有一条曲线可用
                        }
                    }
                }

                fanGroups[fanId] = groupsByFanVsp[fanId][chosenVsp] || [];
                fanIds.push(fanId);
                Controller.pqChosenVspMap[fanId] = chosenVsp;
            });

            // 保存 PQ 数据（原始 & 分组）
            Controller.pqCurveData       = data;
            Controller.pqCurveGroupData  = fanGroups;
            Controller.pqCurveFanIds     = fanIds;
            
            console.log('Controller.pqCurveData,', Controller.pqCurveData)
            console.log('Controller.pqCurveGroupData,', Controller.pqCurveGroupData)
            console.log('Controller.pqCurveFanIds,', Controller.pqCurveFanIds)
            console.log('Controller.pqChosenVspMap,', Controller.pqChosenVspMap)

            // 更新图表
            Controller.updatePQCurveChart(fanGroups, fanIds);

            // 画搜索点 & 容差框，并绑定点击
            Controller.drawSearchPointAndTolerance();
            Controller.bindPQClickEvent();
            
        },

        /* ---------------------------------------------------------
         *  在 PQ 曲线图上绘制：
         *    ▸ 同时输入 flow + pressure   →  矩形 + 中心点
         *    ▸ 仅输入 flow               →  两条垂直线
         *    ▸ 仅输入 pressure           →  两条水平线
         * --------------------------------------------------------- */
        drawSearchPointAndTolerance: function () {
            if (!Controller.pqCurveChart) return;

            /* ---------- 0) 取参数 ---------- */
            const sp = Controller.searchParams || {};
            const tolMin = (parseFloat(sp.toleranceMin) || -30) / 100;
            const tolMax = (parseFloat(sp.toleranceMax) ||  30) / 100;

            const hasFlow     = !!sp.airFlow;
            const hasPressure = !!sp.airPressure;
            if (!hasFlow && !hasPressure) return;

            const flowVal = hasFlow     ? Controller.convertFlow(sp.airFlow)        : 0;
            const presVal = hasPressure ? Controller.convertPressure(sp.airPressure): 0;

            const flowL = flowVal * (1 + tolMin);
            const flowH = flowVal * (1 + tolMax);
            const presL = presVal * (1 + tolMin);
            const presH = presVal * (1 + tolMax);

            /* ---------- 1) 计算需要的坐标轴最大值（把公差端点也算进去） ---------- */
            const getAxisMax = () => {
                const opt = Controller.pqCurveChart.getOption();
                let maxX = 0, maxY = 0;
                if (opt && Array.isArray(opt.series)) {
                    opt.series.forEach(s => {
                        if (!Array.isArray(s.data)) return;
                        if (s.id === 'search-overlay') return;
                        s.data.forEach(pt => {
                            const p = Array.isArray(pt) ? pt : (pt.value || []);
                            maxX = Math.max(maxX, p[0] || 0);
                            maxY = Math.max(maxY, p[1] || 0);
                        });
                    });
                }
                /* ← 新增：将公差上限纳入考虑 */
                if (hasFlow)     maxX = Math.max(maxX, flowH);
                if (hasPressure) maxY = Math.max(maxY, presH);

                return { maxX: maxX * 1.05, maxY: maxY * 1.05 };  // 加 5 % 余量
            };
            const { maxX, maxY } = getAxisMax();

            /* ---------- 2) 组装覆盖层 ---------- */
            const overlay = {
                id: 'search-overlay',
                type: 'line',
                data: [],
                silent: true,
                animation: false,
                symbol: 'none',
                lineStyle: { opacity: 0 },
                z: 0, zlevel: 0
            };

            /* 2-A 矩形 + 点 */
            if (hasFlow && hasPressure) {
                overlay.markPoint = {
                    symbol: 'circle',
                    symbolSize: 8,
                    itemStyle: { color: '#3da0ff', borderColor: '#fff', borderWidth: 1 },
                    data: [{ coord: [flowVal, presVal] }]
                };
                overlay.markArea = {
                    silent: true,
                    itemStyle: {
                        color: 'rgba(179,223,255,0.35)',
                        borderColor: '#3da0ff',
                        borderWidth: 1
                    },
                    data: [[
                        { xAxis: flowL, yAxis: presH },
                        { xAxis: flowH, yAxis: presL }
                    ]]
                };
            }

            /* 2-B 垂直线 */
            if (hasFlow && !hasPressure) {
                overlay.markLine = {
                    silent: true,
                    lineStyle: { color: '#3da0ff', width: 1, type: 'dashed' },
                    data: [
                        [{ xAxis: flowL, yAxis: 0    }, { xAxis: flowL, yAxis: maxY }],
                        [{ xAxis: flowH, yAxis: 0    }, { xAxis: flowH, yAxis: maxY }]
                    ]
                };
            }

            /* 2-C 水平线 */
            if (!hasFlow && hasPressure) {
                overlay.markLine = {
                    silent: true,
                    lineStyle: { color: '#3da0ff', width: 1, type: 'dashed' },
                    data: [
                        [{ xAxis: 0,    yAxis: presL }, { xAxis: maxX, yAxis: presL }],
                        [{ xAxis: 0,    yAxis: presH }, { xAxis: maxX, yAxis: presH }]
                    ]
                };
            }

            /* ---------- 3) 更新图表（新增 xAxis / yAxis max） ---------- */
            Controller.pqCurveChart.setOption({
                xAxis : { max: maxX },
                yAxis : { max: maxY },
                series: [overlay]
            }, /* notMerge */ false);
        },

        // 添加绘制搜索点和浮动范围矩形的方法（替换你原来的整个函数体）
        drawSearchPointAndTolerance1: function () {
			if (!Controller.pqCurveChart || 
				!Controller.searchParams.airFlow || 
				!Controller.searchParams.airPressure) {
				return;
			}

            // 直接从当前表单/缓存里拿“图表所用单位”的数值
            var airFlow = Number($('input[name="air_flow"]').val() || Controller.searchParams.airFlow || 0);
            var airPressure = Number($('input[name="air_pressure"]').val() || Controller.searchParams.airPressure || 0);
            var tolMin = Number($('#tolerance-min').val() || Controller.searchParams.toleranceMin || -30) / 100;
            var tolMax = Number($('#tolerance-max').val() || Controller.searchParams.toleranceMax || 30) / 100;
            if (!airFlow || !airPressure) return;

            // 计算窗口（注意：这些值已经是“当前坐标轴单位”）
            var flowL = airFlow * (1 + tolMin);
            var flowH = airFlow * (1 + tolMax);
            var presL = airPressure * (1 + tolMin);
            var presH = airPressure * (1 + tolMax);
                
            /*var overlaySeries = {
                id: 'search-overlay',        // 关键：固定 id，后续只更新它
                type: 'line',
                name: '',                    // 不进图例
                data: [],
                silent: true,
                animation: false,
                symbol: 'none',
                lineStyle: { opacity: 0 },   // 只显示标记，不画线
                z: 10,                       // 在曲线上面（半透明不挡住）
                markPoint: {
                    symbol: 'circle',
                    symbolSize: 10,
                    itemStyle: { color: '#FF5722' },
                    data: [{ coord: [airFlow, airPressure] }]
                },
                markArea: {
                    itemStyle: {
                        color: 'rgba(255,87,34,0.15)',
                        borderColor: '#FF5722',
                        borderWidth: 1
                    },
                    data: [[
                        { xAxis: flowL, yAxis: presH },   // 左上
                        { xAxis: flowH, yAxis: presL }    // 右下
                    ]]
                }
            };*/
            var overlaySeries = {
              id: 'search-overlay',
              type: 'line',
              name: '',
              data: [],
              silent: true,
              animation: false,
              symbol: 'none',
              lineStyle: { opacity: 0 },

              // 关键：把覆盖层放在曲线下面，避免遮挡
              z: 0,          // 普通折线 series 默认 z≈2，这里设更小即可
              zlevel: 0,

              // 中心点也换成淡蓝
              markPoint: {
                symbol: 'circle',
                symbolSize: 8,
                itemStyle: {
                  color: '#3da0ff',
                  borderColor: '#ffffff',
                  borderWidth: 1
                },
                data: [{ coord: [airFlow, airPressure] }]
              },

              // 淡蓝色矩形
              markArea: {
                silent: true,
                itemStyle: {
                  // #b3dfff 的半透明背景
                  color: 'rgba(179, 223, 255, 0.38)',    // 可再调 0.10~0.20
                  borderColor: '#b3dfff',
                  borderWidth: 1
                },
                // 鼠标悬停时稍微加深一点（可选）
                emphasis: {
                  itemStyle: {
                    color: 'rgba(179, 223, 255, 0.45)',
                    borderColor: '#8bc5ff'
                  }
                },
                data: [[
                  { xAxis: flowL, yAxis: presH },   // 左上
                  { xAxis: flowH, yAxis: presL }    // 右下
                ]]
              }
            };


            // 只更新/追加这条覆盖层，不动其它曲线
            Controller.pqCurveChart.setOption({ series: [overlaySeries] }, /*notMerge=*/false);
        },

		// 添加绘制搜索点和浮动范围矩形的方法
		drawSearchPointAndTolerance3: function() {
			if (!Controller.pqCurveChart || 
				!Controller.searchParams.airFlow || 
				!Controller.searchParams.airPressure) {
				return;
			}
			
			// 转换单位
			var airFlow = Controller.convertFlow(Controller.searchParams.airFlow);
			var airPressure = Controller.convertPressure(Controller.searchParams.airPressure);
			
			// 计算浮动范围
			var minFlow = airFlow * (1 + Controller.searchParams.toleranceMin / 100);
			var maxFlow = airFlow * (1 + Controller.searchParams.toleranceMax / 100);
			var minPressure = airPressure * (1 + Controller.searchParams.toleranceMin / 100);
			var maxPressure = airPressure * (1 + Controller.searchParams.toleranceMax / 100);
			
			// 获取当前图表配置
			var option = Controller.pqCurveChart.getOption();
			
			// 添加搜索点标记
			var markPoint = {
				symbol: 'circle',
				symbolSize: 10,
				itemStyle: {
					color: 'red'
				},
				data: [{
					name: 'Search Point',
					value: [airFlow, airPressure],
					xAxis: airFlow,
					yAxis: airPressure
				}]
			};
			
			// 添加浮动范围矩形
			var markArea = {
				itemStyle: {
					color: 'rgba(255, 0, 0, 0.2)',
					borderColor: 'red',
					borderWidth: 0
				},
				data: [[{
					name: '',
					xAxis: minFlow,
					yAxis: maxPressure
				}, {
					xAxis: maxFlow,
					yAxis: minPressure
				}]]
			};
			
			// 更新图表
			Controller.pqCurveChart.setOption({
				series: [{
					type: 'line',
					markPoint: markPoint,
					markArea: markArea,
					data: []
				}]
			});
		},
        
        // 转换流量单位
        convertFlow: function (value) {
            var flowUnit = Controller.getFlowUnit();
            return UnitSettings.convertValue(value, 'm³/h', flowUnit, 'flow');
            
        },
        
        // 转换压力单位
        convertPressure: function (value) {
            var pressureUnit = Controller.getPressureUnit();
            return UnitSettings.convertValue(value, 'Pa', pressureUnit, 'pressure');
        },
        
        // 更新 PQ 曲线图表
        updatePQCurveChart: function (fanGroups, fanIds) {
            if (!Controller.pqCurveChart) return;
            
            var series = [];
            var legendData = [];
            
            // 获取风机名称
            var getFanName = function (fanId) {
                // 从表格中获取风机名称
                var _table = $('#fan-results-table');
                if (_table.length > 0) {
                    var tableData = _table.bootstrapTable('getData');
                    for (var i = 0; i < tableData.length; i++) {
                        if (parseInt(tableData[i].id) === fanId) {
                            return tableData[i].fan_model || ('ID: ' + fanId);
                        }
                    }
                }
                return 'Fan ' + fanId;
            };
            
            // 为每个风机创建一个系列
            fanIds.forEach(function (fanId) {
                var fanName = getFanName(fanId);
                var isHighlighted = (fanId === Controller.highlightedModel);
                
                // 按风量排序数据点
                //var data = fanGroups[fanId].sort(function (a, b) {
                //    return a[0] - b[0];
                //});
                /*
                var data = fanGroups[fanId]
                  .slice()
                  .sort(function (a, b) {
                    // a[2]/b[2] 即 air_pressure_amend；兜底回退到 flow
                    if (a[2] != null && b[2] != null) return a[2] - b[2];
                    return a[0] - b[0];
                  })
                  .map(function (p) { return [p[0], p[1]]; }); // 只把 [flow, pres] 传给 series           
                */
                var data = fanGroups[fanId].map(p => [p[0], p[1]]);
                // 创建系列
                var seriesItem = {
                    id: fanId.toString(),
                    name: fanName,
                    type: 'line',
                    data: data,
                    smooth: true,
                    symbol: 'none',
                    triggerLineEvent: true,
                    symbolSize: isHighlighted ? 8 : 5,
                    lineStyle: {
                        width: isHighlighted ? 3 : 1,
                        opacity: isHighlighted ? 1 : 0.8
                    },
                    itemStyle: {
                        borderWidth: isHighlighted ? 2 : 1,
                        opacity: isHighlighted ? 1 : 0.8
                    },
                    emphasis: {
                        lineStyle: {
                            width: 4,
                            opacity: 1
                        },
                        symbolSize: 10,
                        itemStyle: {
                            opacity: 1
                        }
                    }
                };
                
                series.push(seriesItem);
                legendData.push(fanName);
            });
            
            // 更新图表
			Controller.pqCurveChart.setOption({
				legend: { data: legendData },
				series: series
			});  // 使用 true 参数确保完全替换而不是合并
        },
        
        // 高亮指定风机的曲线
        highlightPQCurve: function (fanId) {
            if (!Controller.pqCurveChart) return;
            
            Controller.highlightedModel = fanId;
            
            // 获取当前图表的配置
            var option = Controller.pqCurveChart.getOption();
            var series = option.series;
            
            if (!series || !series.length) return;
            
            // 更新每个系列的样式
            for (var i = 0; i < series.length; i++) {
                var seriesName = series[i].name;
                var seriesFanId = null;
                
                // 从表格中获取风机 ID
                var _table = $('#fan-results-table');
                if (_table.length > 0) {
                    var tableData = _table.bootstrapTable('getData');
                    for (var j = 0; j < tableData.length; j++) {
                        if (seriesName === (tableData[j].fan_model || ('ID: ' + tableData[j].id))) {
                            seriesFanId = parseInt(tableData[j].id);
                            break;
                        }
                    }
                }
                
                var isHighlighted = (seriesFanId === fanId);
                
                series[i].lineStyle = {
                    width: isHighlighted ? 3 : 1,
                    opacity: isHighlighted ? 1 : 0.3
                };
                
                series[i].itemStyle = {
                    borderWidth: isHighlighted ? 2 : 1,
                    opacity: isHighlighted ? 1 : 0.3
                };
                
                series[i].symbolSize = isHighlighted ? 8 : 5;
            }
            
            // 更新图表
            Controller.pqCurveChart.setOption({
                series: series
            });
        },
		// PQ 曲线相关属性2
		
        index: function () {

            // 初始化设置
            UnitSettings.init();

			// 获取后端传递的数据
			if (typeof originalFanData !== 'undefined') {
				Controller.originalData = originalFanData;
			}
            // 初始化表格
            Controller.initTable();

			
			// 加载默认风机的 PQ 数据 2025.05.01
            Controller.initPQCurveChart();

            // (1) 风机类型点击
            $(document).on('click', '.fan-type-box', function () {
                $(this).toggleClass('active');
                $('#fan-results-table').bootstrapTable('refresh', {pageNumber:1});
            });
            // 全选 / 全不选同理

            // (2) 左侧筛选表单
            Form.api.bindevent($('#fan-filter-form'), function(){}, function(){}, function(){
                //let air_flow = $('input[name="air_flow"]').val();
                //let air_pressure = $('input[name="air_pressure"]').val();
                //if ( air_flow == '' ) {
                //    $('input[name="air_flow"]').val( Controller.convertFlow(1000) );
                //}
                //if ( air_pressure == '' ) {
                //    $('input[name="air_pressure"]').val( Controller.convertPressure(200) );
                //}
                $('#fan-results-table').bootstrapTable('refresh', {pageNumber:1});
                return false;
            });

            // (3) 表头 filter-control
            let csTimer = null;
            $('#fan-results-table').on('column-search.bs.table', function () {
                clearTimeout(csTimer);
                csTimer = setTimeout(function () {
                    $('#fan-results-table').bootstrapTable('refresh', {pageNumber:1});
                }, 800);          // 400ms 停顿后才真正刷新
            });

            /*
            // 风机类型选择
            $(document).on('click', '.fan-type-box', function () {
                $(this).toggleClass('active');
                Controller.updateCompareButton();
            });
            */
            // 全选按钮
            $(document).on('click', '#select-all', function () {
                $('.fan-type-box').addClass('active');
                Controller.updateCompareButton();
            });

            // 全不选按钮
            $(document).on('click', '#select-none', function () {
                $('.fan-type-box').removeClass('active');
                Controller.updateCompareButton();
            });

            // 比较按钮点击
            $(document).on('click', '#compare-btn', function () {
                var selections = $('#fan-results-table').bootstrapTable('getSelections');
                
                if (selections.length > 1) {
                    var ids = selections.map(function(item) { return item.id; }).join(',');
                    window.open(Frontend.api.fixurl('fan/compare') + '/ids/' + ids, '_blank');
                } else {
                    Layer.msg(__('Please select at least 2 fans to compare'), {icon: 2});
                }
            });

            // 表单重置
            $(document).on('click', '#fan-filter-form button[type="reset"]', function () {
                $('#fan-filter-form')[0].reset();
                
                setTimeout(function() {
                    // 重新应用当前单位设置
                    var currentUnits = UnitSettings.getCurrentUnits();
                    $.each(currentUnits, function(unitType, unitValue) {
                        UnitSettings.updateUnitLabels(currentUnits);
                    });
                }, 50);
                return false;
            });
            
            // 监听单位变化事件
            $(document).on('units:changed', function(e, settings) {
                // 如果表格已经有数据，重新渲染表格
                if (Controller.originalData.length > 0) {
                    var processedData = Controller.processTableData(Controller.originalData);
                    $('#fan-results-table').bootstrapTable('load',  {
                        total : Controller.lastTotal,  
                        rows  : processedData
                    });
					
					// 获取当前列配置
					//var columns = $('#fan-results-table').bootstrapTable('getOptions').columns[0]; // 获取第二行（标题行）
					
					// 更新表格
					//$('#fan-results-table').bootstrapTable('refreshOptions', {
					//	data: processedData,
					//	columns: columns
					//});
					
					// 构建表头
					Controller.addUnitHeaderRow();
					
					do_changesearch();
                }
				
			  // 根据流量单位调整滑块范围
				if (settings.flow) {
					let newRange;
								
				    const conversionFactors = UnitSettings.conversionFactors.flow;
					
					switch(settings.flow) {
						case 'm³/h':
							// 原始单位，直接使用
							newRange = ori_flow;
							break;
						case 'm³/s':
							// 使用转换因子计算
							newRange = [
								ori_flow[0] * conversionFactors['m³/s'],  // 最小值转换
								ori_flow[1] * conversionFactors['m³/s']   // 最大值转换
							];
							break;
						case 'l/s':
							newRange = [
								ori_flow[0] * conversionFactors['l/s'],
								ori_flow[1] * conversionFactors['l/s']
							];
							break;
						case 'CFM':
							newRange = [
								ori_flow[0] * conversionFactors['CFM'],
								ori_flow[1] * conversionFactors['CFM']
							];
							break;
						default:
							newRange = ori_flow;
					}
					
					// 对范围值进行合理的四舍五入处理
					newRange = newRange.map(value => {
						// 根据数值大小决定保留的小数位数
						if (Math.abs(value) >= 100) {
							return Math.round(value); // 大数值取整
						} else if (Math.abs(value) >= 10) {
							return Math.round(value * 10) / 10; // 保留1位小数
						} else if (Math.abs(value) >= 1) {
							return Math.round(value * 100) / 100; // 保留2位小数
						} else {
							return Math.round(value * 1000) / 1000; // 小数值保留3位小数
						}
					});
					
					// 更新滑块范围
					if (window.sliderControls.air_flow) {
						window.sliderControls.air_flow.updateRange(newRange);
					}
					
					
				}

				// 同样处理压力单位
				if (settings.pressure) {
					let newRange;
					switch(settings.pressure) {
						case 'Pa':
							newRange = [1, 1000];
							break;
						case 'kPa':
							newRange = [0.001, 1]; // 约等于 1-20000 Pa
							break;
						case 'bar':
							newRange = [0.00001, 0.01]; // 约等于 1-20000 Pa
							break;
						case 'mbar':
							newRange = [0.01, 10]; // 约等于 1-20000 Pa
							break;
						// 其他单位类似处理
						default:
							newRange = [1, 20000];
					}
					
					// 更新滑块范围
					if (window.sliderControls.air_pressure) {
						window.sliderControls.air_pressure.updateRange(newRange);
					}
				}
				
            });
			
			// 区间范围负号监控
			$('#tolerance-min').on('input', function() {
				let value = $(this).val();
				
				// 移除所有非数字和非负号字符
				value = value.replace(/[^\d-]/g, '');
				
				// 处理多个负号的情况，只保留第一个负号
				if (value.indexOf('-') !== -1) {
					value = '-' + value.replace(/-/g, '');
				}
				
				// 如果没有负号，自动添加负号
				if (value && !value.startsWith('-')) {
					value = '-' + value;
				}
				
				// 如果只有负号，保留负号
				if (value === '-') {
					$(this).val(value);
					return;
				}
				
				// 转换为数字并格式化，确保是负数
				let numValue = parseInt(value, 10);
				if (!isNaN(numValue)) {
					// 如果是正数，转为负数
					numValue = numValue > 0 ? -numValue : numValue;
					$(this).val(numValue);
				} else {
					// 如果不是有效数字，但有负号，保留负号
					$(this).val('-');
				}
			});
			
			// 处理tolerance-max输入框
			$('#tolerance-max').on('input', function() {
				let value = $(this).val();
				
				// 移除所有非数字字符和负号
				value = value.replace(/[^\d]/g, '');
				
				// 转换为数字并格式化
				let numValue = parseInt(value, 10);
				if (!isNaN(numValue)) {
					$(this).val(numValue);
				} else {
					$(this).val('');
				}
			});
			
			// 在页面加载时确保初始值符合规则
			let minValue = $('#tolerance-min').val();
			if (minValue && !minValue.startsWith('-')) {
				$('#tolerance-min').val('-' + minValue);
			}
			
        },

		// 范围筛选器
		rangeFilter: function(value, searchText) {
			if (!searchText) return true;
			
			// 解析 min/max 格式的搜索文本
			var parts = searchText.split('/');
			var min = parts[0] ? parseFloat(parts[0]) : null;
			var max = parts[1] ? parseFloat(parts[1]) : null;
			
			// 将值转换为数字
			var numValue = parseFloat(value);
			
			// 检查是否在范围内
			if (min !== null && numValue < min) return false;
			if (max !== null && numValue > max) return false;
			
			return true;
		},

		// 添加单位行
		addUnitHeaderRow: function() {
			// 获取当前单位设置
			var currentUnits = UnitSettings.getCurrentUnits();
			
			// 移除现有的单位行（如果有）
			$('.unit-header-row').remove();
			
			// 创建单位行
			var $unitRow = $('<tr class="unit-header-row"></tr>');
			
			// 获取表格头部的所有列
			$('#fan-results-table thead th').each(function() {
				var $th = $(this);
				var field = $th.data('field');
				var unitText = '';
				
				// 根据字段设置单位
				if (field === 'air_flow') {
					unitText = currentUnits.flow || 'm³/h';
				} else if (field === 'air_pressure') {
					unitText = currentUnits.pressure || 'Pa';
				} else if (field === 'rated_power') {
					unitText = currentUnits.power || 'W';
				} else if (field === 'rated_speed') {
					unitText = 'rpm';
				} else if (field === 'impeller_diameter') {
					unitText = currentUnits.dimension || 'mm';
				} else if (field === 'rated_voltage') {
					unitText = 'V';
				}
				
				// 创建单元格
				var $unitCell = $('<th></th>')
					.addClass('unit-header field')
					.text(unitText)
					.css('text-align', 'center');
				
				$unitRow.append($unitCell);
			});
			console.log($unitRow);
			// 将单位行插入到表格头部的最前面
			$('#fan-results-table thead').append($unitRow);
		},
		
        // 初始化表格
        initTable: function() {

            // 确保扩展已加载
            if ($.fn.bootstrapTable.defaults.filterControl === undefined) {
                console.error('Filter control extension not loaded properly');
                return;
            }
            			
            // 获取表格元素
            var _table = $('#fan-results-table');
            
            // 定义表格列
            var _columns = [
                {
                    field: 'state',
                    checkbox: true
                },
                {
                    field: 'image',
					align: 'center',
					valign: 'text-top',
					showSelectTitle: false,
                    title: __('Image'),
                    formatter: function (value, row, index) {
                        return '<img src="' + value + '" class="img-thumbnail" style="max-width: 50px; max-height: 50px;">';
                    }
                },
				{
					field: 'fan_model',
					align: 'center',
					valign: 'text-top',
					title: __('Fan Model'),
					filterControl: 'input',  // 添加筛选控件
					filterStrictSearch: false,
					filterControlPlaceholder: '',
					sortable: true,
					formatter: function(value, row, index) {
						var html = '<a class="viewdetails" href="' + Frontend.api.fixurl('fan/detail/id/') + row.id + '" target="_blank">' + value + '</a>';
						return html;
					}
				},
                {
                    field: 'motor_type',
					align: 'center',
					valign: 'text-top',
					sortable: true,
					filterControl: 'select',  // 添加筛选控件
					filterStrictSearch: false,
					filterControlPlaceholder: '',
                    title: __('Motor Type'),
                    filterData : 'json:{"AC":"AC","DC":"DC","EC":"EC","/":"/"}',
                    filterControlVisible: 'always'
                },
                {
                    field: 'type_name',
					align: 'center',
					valign: 'text-top',
                    title: __('Fan Type')
                },
				{
					field: 'powertype',
					align: 'center',
					valign: 'text-top',
					visible: false,
					title: __('Power Type'),
					
				},
				{
					field: 'rated_voltage',
					align: 'center',
					valign: 'text-top',
					filterControl: 'range', // 数值类型使用范围筛选
					//filterCustomSearch: Controller.rangeFilter,
					//filterControlPlaceholder: '',
					title: __('Rated Voltage'),
					sortable: true,
					formatter: function(value, row, index) {
						if (!value) return '-';
						return value + ' <span class="unit-label hide">V</span>';
					}
				},
				{
					field: 'air_flow',
					align: 'center',
					valign: 'text-top',
					filterControl: 'range', // 数值类型使用范围筛选
					//filterCustomSearch: Controller.rangeFilter,
					//filterControlPlaceholder: '',
					title: __('Air Flow'),
					sortable: true,
					formatter: function(value, row, index) {
						if (!value) return '-';
						var units = UnitSettings.getCurrentUnits();
						var flowUnit = units.flow || 'm³/h';
						var convertedValue = toFixedValue(UnitSettings.convertValue(value, 'm³/h', flowUnit, 'flow'), flowUnit);
						return '<span class="value">' + convertedValue + '</span><br><span class="unit-label hide">' + flowUnit + '</span>';
					}
				},

				{
					field: 'air_pressure',
					align: 'center',
					valign: 'text-top',
					filterControl: 'range', // 数值类型使用范围筛选
					//filterCustomSearch: Controller.rangeFilter,
					//filterControlPlaceholder: '',
					title: __('Air Pressure'),
					sortable: true,
					formatter: function(value, row, index) {
						if (!value) return '-';
						var units = UnitSettings.getCurrentUnits();
						var pressureUnit = units.pressure || 'Pa';
						var convertedValue = toFixedValue(UnitSettings.convertValue(value, 'Pa', pressureUnit, 'pressure'), pressureUnit);
						return '<span class="value">' + convertedValue + '</span><br><span class="unit-label hide">' + pressureUnit + '</span>';
					}
				},
				{
					field: 'rated_power',
					align: 'center',
					valign: 'text-top',
					filterControl: 'range', // 数值类型使用范围筛选
					//filterCustomSearch: Controller.rangeFilter,
					//filterControlPlaceholder: '',
					title: __('Rated Power'),
					sortable: true,
					formatter: function(value, row, index) {
						if (!value) return '-';
						var units = UnitSettings.getCurrentUnits();
						var powerUnit = units.power || 'W';
						var convertedValue = toFixedValue(UnitSettings.convertValue(value, 'W', powerUnit, 'power'), powerUnit);
						return '<span class="value">' + convertedValue + '</span><br><span class="unit-label hide">' + powerUnit + '</span>';
					}
				},
				{
					field: 'rated_speed',
					align: 'center',
					valign: 'text-top',
					filterControl: 'range', // 数值类型使用范围筛选
					//filterCustomSearch: Controller.rangeFilter,
					//filterControlPlaceholder: '',
					title: __('Speed'),
					sortable: true,
					formatter: function(value, row, index) {
						if (!value) return '-';
						return value;
					}
				},
				{
					field: 'custom_str3',
					align: 'center',
					valign: 'text-top',
					filterControl: 'select',  // 添加筛选控件
					filterStrictSearch: false,
					sortable: true,
					title: __('Fan Series'),
                    filterData: fan_series,
                    filterControlVisible: 'always'
				},
				{
					field: 'outline_length',
					align: 'center',
					valign: 'text-top',
					filterControl: 'range', // 数值类型使用范围筛选
					//filterCustomSearch: Controller.rangeFilter,
					//filterControlPlaceholder: '',
					title: __('Outline Length'),
					sortable: true,
					formatter: function(value, row, index) {
						if (!value) return '-';
						return value;
					}
				},
				{
					field: 'outline_width',
					align: 'center',
					valign: 'text-top',
					filterControl: 'range', // 数值类型使用范围筛选
					//filterCustomSearch: Controller.rangeFilter,
					//filterControlPlaceholder: '',
					title: __('Outline Width'),
					sortable: true,
					formatter: function(value, row, index) {
						if (!value) return '-';
						return value;
					}
				},
				{
					field: 'outline_height',
					align: 'center',
					valign: 'text-top',
					filterControl: 'range', // 数值类型使用范围筛选
					//filterCustomSearch: Controller.rangeFilter,
					//filterControlPlaceholder: '',
					title: __('Outline Height'),
					sortable: true,
					formatter: function(value, row, index) {
						if (!value) return '-';
						return value;
					}
				},
				{
					field: 'impeller_diameter',
					align: 'center',
					valign: 'text-top',
					filterControl: 'range', // 数值类型使用范围筛选
					//filterCustomSearch: Controller.rangeFilter,
					//filterControlPlaceholder: '',
					title: __('Impeller Diameter'),
					sortable: true,
					formatter: function(value, row, index) {
						if (!value) return '-';
						var units = UnitSettings.getCurrentUnits();
						var dimensionUnit = units.dimension || 'mm';
						var convertedValue = UnitSettings.convertValue(value, 'mm', dimensionUnit, 'dimension');
						return '<span class="value">' + (convertedValue - 0).toFixed(1) + '</span><br><span class="unit-label hide">' + dimensionUnit + '</span>';
					}
				}
			
            ];
			
			// 获取当前单位设置
			var currentUnits = UnitSettings.getCurrentUnits();
			
            // 初始化表格
            _table.bootstrapTable({
                columns: _columns,
                stickyHeader: true,                // 开启
                stickyHeaderOffsetY: ($('.navbar').outerHeight() || 0) + 'px', // 顶部导航高度
                //data: Controller.originalData,
                url: Frontend.api.fixurl('fan/search'),   // 后端同一入口
                method: 'post',
                sidePagination: 'server',
                pagination: true,
                pageSize: 15,
                pageList: [15,35,55,100],
                queryParams: Controller.buildQueryParams,
                responseHandler: Controller.responseHandler,
				toolbar: '#toolbar',
				striped: true,
                search: true,
                showRefresh: false,
                showToggle: false,
                showColumns: true,
                showPaginationSwitch: false,
                showExport: true,
                exportTypes: ['csv', 'txt', 'excel'],
                exportOptions: {
                    fileName: 'fan_search_results_' + new Date().toISOString().slice(0, 10)
                },
                detailView: false,
                minimumCountColumns: 2,
                uniqueId: 'id',
                clickToSelect: true,
				filterControl: true,  // 启用筛选控件
				filterShowClear: true, // 显示清除筛选按钮
				searchTimeOut: 400,
                
                onLoadSuccess: function() {
					console.log('onLoadSuccess');
                    Controller.updateCompareButton();
                },
                onCheck: function() {
					console.log('onCheck');
                    Controller.updateCompareButton();
                },
                onUncheck: function() {
					console.log('onUncheck');
                    Controller.updateCompareButton();
                },
                onCheckAll: function() {
					console.log('onCheckAll');
                    Controller.updateCompareButton();
                },
                onUncheckAll: function() {
					console.log('onUncheckAll');
                    Controller.updateCompareButton();
                },
                
				onPostHeader: function() {
					console.log('onPostHeader');
					// 添加单位行
					//Controller.addUnitHeaderRow();
            
					// 调整筛选输入框
					//Controller.adjustFilterInputs();
				},
				//onPostBody: function () {
				//	console.log('onPostBody');
				//	setTimeout( () => {Controller.scheduleLoadPQ();$('#pq-curve-container').css('visibility', 'visible');}, 666);
				//}
                
            });
            
            Controller.addUnitHeaderRow();
            
            // 更新总数显示
            //$('#total-count').text(Controller.originalData.length);
            
            // 绑定选择事件
            _table.on('load-success.bs.table', function () {
                Controller.scheduleLoadPQ();
                $('#pq-curve-container').css('visibility', 'visible');
            });
            
            _table.on('check.bs.table uncheck.bs.table check-all.bs.table uncheck-all.bs.table', function (e, rows) {
                var selectedRows = _table.bootstrapTable('getSelections');
                $('#compare-btn').prop('disabled', selectedRows.length < 2);
            });
						
			// 点击表格行加载对应风机的 PQ 数据 2025.04.29
			// 添加鼠标悬停事件
            var hoverTimer;
            _table.on('mouseover', 'tbody tr', function (e, rows) {
                var $row = $(this);
                var rowData = _table.bootstrapTable('getData')[$row.data('index')];
                
                if (rowData && rowData.id) {
                    // 清除之前的定时器
                    clearTimeout(hoverTimer);
                    
                    // 设置新的定时器，延迟 100 毫秒执行
                    hoverTimer = setTimeout(function () {
                        // 高亮该风机的曲线
                        Controller.highlightPQCurve(parseInt(rowData.id));
                    }, 100);
                }
            });
            
            // 鼠标离开表格时恢复所有曲线
            _table.on('mouseout', 'tbody', function (e, rows) {
                clearTimeout(hoverTimer);
                Controller.highlightedModel = null;
                
                // 恢复所有曲线的默认样式
                if (Controller.pqCurveChart) {
                    var option = Controller.pqCurveChart.getOption();
                    var series = option.series;
                    
                    if (series && series.length) {
                        for (var i = 0; i < series.length; i++) {
                            series[i].lineStyle = {
                                width: 2,
                                opacity: 1
                            };
                            
                            series[i].itemStyle = {
                                borderWidth: 1,
                                opacity: 1
                            };
                            
                            series[i].symbolSize = 5;
                        }
                        
                        Controller.pqCurveChart.setOption({
                            series: series
                        });
                    }
                }
            });
            
			// 确保表格筛选后也会更新 PQ 曲线
			_table.on('column-search.bs.table', function (e, rows) {
				console.log('column-search.bs.table');
				//Controller.loadTableFansPQData();
			});
			
			// 确保表格排序后也会更新 PQ 曲线
			_table.on('sort.bs.table', function (e, rows) {
				console.log('column-search.bs.table');
				//Controller.loadTableFansPQData();
			});

            //_table.bootstrapTable('refreshOptions', {
            //    stickyHeaderOffsetY: ($('.navbar').outerHeight() || 0) + 'px'
            //});
            
            
            setTimeout(() => {
                            
                var $table = $('#fan-results-table');
                
                function applyFilterValuesTo($thead, inst){
                      if (!$thead || !$thead.length || !inst) return;

                      // 事件态：你在 onColumnSearch 里维护的“真相”
                      const kv = inst.filterColumnsPartial || {};
                      Object.keys(kv).forEach(k => {
                        const isMin = /_min$/.test(k), isMax = /_max$/.test(k);
                        const base  = k.replace(/_(min|max)$/,'');
                        const $cell = $thead.find(`[data-field="${base}"]`);
                        if (!$cell.length) return;

                        if (isMin || isMax) {
                          $cell.find(isMin ? '.range-min' : '.range-max').val(kv[k]);
                        } else {
                          const $sel = $cell.find('select');
                          if ($sel.length) $sel.val(kv[k]); else $cell.find('input').val(kv[k]);
                        }
                      });

                      // 兜底：filter-control 的缓存（如果你在 options.valuesFilterControl 里也存了值）
                      const vfc = (inst.options && inst.options.valuesFilterControl) || [];
                      vfc.forEach(({field, value}) => {
                        const isMin = /_min$/.test(field), isMax = /_max$/.test(field);
                        const base  = field.replace(/_(min|max)$/,'');
                        const $cell = $thead.find(`[data-field="${base}"]`);
                        if (!$cell.length) return;

                        if (isMin || isMax) {
                          const cls = isMin ? '.range-min' : '.range-max';
                          if (!$cell.find(cls).val()) $cell.find(cls).val(value);
                        } else {
                          const $sel = $cell.find('select');
                          if ($sel.length && !$sel.val()) $sel.val(value);
                          else {
                            const $inp = $cell.find('input');
                            if ($inp.length && !$inp.val()) $inp.val(value);
                          }
                        }
                      });
                }


                function attachAfterStickyReady() {
                    var $ctn  = $table.closest('.fixed-table-container');
                    var $body = $ctn.find('.fixed-table-body');

                    // 真・要横向移动的那个内层 <div>
                    function getWrap() {
                        return $ctn.find('.fix-sticky thead');
                    }

                    function attach($wrap) {
                        var inst = $('#fan-results-table').data('bootstrap.table');
                        applyFilterValuesTo($wrap, inst);
    
                        // 同步宽度 & 初次位置
                        function update() {
                            var w = $body.find('table').outerWidth() || 0;
                            if (w) $wrap.width(w);
                            $wrap.css('transform', 'translateX(' + (-$body.scrollLeft()) + 'px)');
                        }
                        // 横向滚动实时同步
                        $body.off('scroll.stickyX').on('scroll.stickyX', function () {
                            $wrap.css('transform', 'translateX(' + (-this.scrollLeft) + 'px)');
                        });
                        $(window).off('resize.stickyX').on('resize.stickyX', update);
                        update();
                    }

                    // 1) 现在就有就直接绑
                    var $wrap = getWrap();
                    if ($wrap.length) { attach($wrap); return; }

                    // 2) 现在还没有——用 MutationObserver 等它出现再绑
                    var mo = new MutationObserver(function () {
                        var $w = getWrap();
                        if ($w.length) {
                            mo.disconnect();
                            attach($w);
                        }
                    });
                    if ($ctn[0]) mo.observe($ctn[0], { childList: true, subtree: true });

                    // 3) 兜底：首次下滑时再试一次（有些版本是滚动后才创建容器）
                    $(window).off('scroll.stickyXfind').on('scroll.stickyXfind', function () {
                        var $w = getWrap();
                        if ($w.length) {
                            $(window).off('scroll.stickyXfind');
                            attach($w);
                        }
                    });
                }

                // 仅在数据真正渲染到 tbody 后再运行；刷新/分页/切换列后也重绑一次
                var rebind = function(){ setTimeout(attachAfterStickyReady, 0); };
                $table.on('load-success.bs.table post-body.bs.table reset-view.bs.table column-switch.bs.table refresh-options.bs.table', rebind);

                $table.on('post-header.bs.table', function(){
                    var inst = $table.data('bootstrap.table');
                    applyFilterValuesTo($table.find('thead'), inst);   // 原始 thead 回灌
                });

                // 首次尝试
                rebind();
              
                
            }, 777);
			return false;

        },
        
        responseHandler: function (res) {
            if (res.code === 1){
                Controller.originalData = res.data || [];
                //$('#total-count').text(res.total || 0);          // 右上角数量
                Controller.lastTotal = res.total || 0;           // 记住真正总数
                $('#total-count').text(Controller.lastTotal);
                return {rows: Controller.processTableData(res.data), total: res.total};
            }
            return {rows:[], total:0};
        },
        
        buildQueryParams: function (params) {
            const q = {};

            /* ---------- 分页 ---------- */
            q.page   = (params.offset / params.limit) + 1; // 转成后端用的 page
            q.limit  = params.limit;
            
            /* ---------- 排序 ---------- */
            if (params.sort) {          // 只有在点击列头时才会带这两个值
                q.sort  = params.sort;  // 列字段名
                q.order = params.order; // asc / desc
            }

            /* ---------- 默认条件 ---------- */
            q.status = 1;                                  // 保证只要正常风机

            /* ---------- 风机类型 ---------- */
            q.fan_type_ids = $('.fan-type-box.active')
                             .map(function(){return $(this).data('type-id');})
                             .get()
                             .join(',');

            /* ---------- 表头 filter ---------- */
            $('#fan-results-table thead').find('input,select').each(function () {
                const field = $(this).closest('[data-field]').data('field');
                const val   = $(this).val();
                if (val !== '' && typeof field !== 'undefined') {
                    q[field] = val;                        // 文本 / 下拉
                }
                if ($(this).hasClass('range-min') || $(this).hasClass('range-max')) {
                    // 数值范围：min/max 两个独立控件 -> field_min / field_max
                    const postfix = $(this).hasClass('range-min') ? '_min' : '_max';
                    q[field + postfix] = val;
                }
            });

            /* ---------- 左侧筛选表单 ---------- */
            $.each($('#fan-filter-form').serializeArray(), function(_, f){
                if (f.value) q[f.name] = f.value;
            });
            
            Controller.searchParams = {
                airFlow: Number(q.air_flow || $('input[name="air_flow"]').val() || 0),
                airPressure: Number(q.air_pressure || $('input[name="air_pressure"]').val() || 0),
                toleranceMin: Number(q.tolerance_min || $('#tolerance-min').val() || -30),
                toleranceMax: Number(q.tolerance_max || $('#tolerance-max').val() || 30)
            };
            
            setCookie('fanSearchParams', JSON.stringify(Controller.searchParams));

            return q;
        },

        // 根据选中的风机类型过滤表格
        filterTableByTypes: function() {
            return false;
            var _table = $('#fan-results-table');
            var selectedTypes = [];
            
            // 获取所有选中的风机类型
            $('.fan-type-box.active').each(function() {
                selectedTypes.push($(this).data('type-id'));
            });
            
            // 如果没有选中任何类型，显示所有数据
            if (selectedTypes.length === 0) {
                _table.bootstrapTable('load', Controller.originalData);
                $('#total-count').text(Controller.originalData.length);
                return;
            }
            
            // 过滤数据
            var filteredData = Controller.originalData.filter(function(item) {
                return selectedTypes.includes(item.fan_type_id);
            });
            
            // 更新表格
            //_table.bootstrapTable('load', filteredData);
            //$('#total-count').text(filteredData.length);
            //20250612
            _table.bootstrapTable('load', {
                total: Controller.lastTotal,  
                rows : filteredData
            });
            $('#total-count').text(Controller.lastTotal);
        },
        
		
        // 更新比较按钮状态
        updateCompareButton: function () {
            // 过滤表格数据
            Controller.filterTableByTypes();
			
            var selections = $('#fan-results-table').bootstrapTable('getSelections');
            $('#compare-btn').prop('disabled', selections.length < 2);
        },
        
        // 搜索风机
        searchFans: function () {
            var selectedTypes = [];
            $('.fan-type-box.active').each(function () {
                selectedTypes.push($(this).data('type-id'));
            });
            
            // 显示全屏加载层
            var loadIndex = Layer.load(4, {shade: [0.3, '#fff']});

            // 获取表单数据
            var formData = $('#fan-filter-form').serializeArray();
            var params = {};
            let tolerance_min = $('#tolerance-min').val() || '-30';
            let tolerance_max = $('#tolerance-max').val() || '30';

            // 处理表单数据
            $.each(formData, function (i, field) {
                if (field.value) {
                    params[field.name] = field.value;
                }
            });

			// 保存搜索参数，用于绘制标注点和浮动范围
			Controller.searchParams = {
				airFlow: parseFloat(params.air_flow || 0),
				airPressure: parseFloat(params.air_pressure || 0),
				toleranceMin: parseFloat(tolerance_min),
				toleranceMax: parseFloat(tolerance_max)
			};
	
            // 添加风机类型
            params.fan_type_ids = selectedTypes.join(',');
            
            // 获取当前单位设置
            var currentUnits = UnitSettings.getCurrentUnits();
            
            // 添加单位信息，以便后端知道数据的单位
            params.units = JSON.stringify(currentUnits);

            // 添加容差范围
            params.tolerance_min = tolerance_min;
            params.tolerance_max = tolerance_max;

            // 发送AJAX请求
            $.ajax({
                url: Frontend.api.fixurl('fan/search'),
                type: 'POST',
                data: params,
                dataType: 'json',
                success: function (ret) {
                    if (ret.code === 1 && ret.data && ret.data.length > 0) {
                        // 保存原始数据
                        Controller.originalData = ret.data;
                        
                        // 处理数据并加载到表格
                        //var processedData = Controller.processTableData(ret.data);
                        //$('#fan-results-table').bootstrapTable('load', processedData);
                        //20250612
                        var processedData = Controller.processTableData(ret.data);
                        $('#fan-results-table').bootstrapTable('load', {
                            total: ret.total,          // ← 一定要带！
                            rows : processedData
                        });
                        // 更新总数显示
                        $('#total-count').text(ret.total);
                    } else {
                        $('#fan-results-table').bootstrapTable('removeAll');
                        Layer.msg(ret.msg || __('No matching fans found'), {icon: 2});
                        $('#total-count').text('0');
                    }
                    Layer.close(loadIndex);
                },
                error: function () {
                    $('#fan-results-table').bootstrapTable('removeAll');
                    Layer.msg(__('Network error'), {icon: 2});
                    $('#total-count').text('0');
                    Layer.close(loadIndex);
                }
            });
        },
        
        // 处理表格数据，添加格式化的值
        processTableData: function(data) {
            if (!data || data.length === 0) {
                return [];
            }
            
            // 获取当前单位设置
            var currentUnits = UnitSettings.getCurrentUnits();
            
            // 处理每一行数据
            return data.map(function(item) {
                // 创建新对象，避免修改原始数据
                var row = $.extend({}, item);
                
                // 确保所有需要的字段都存在
                row.fan_model = row.fan_model || '';
                row.protection_type = row.protection_type || '/';
                row.insulation_class = row.insulation_class || '/';
                row.motor_type = row.motor_type || '/';
                row.rotor_type = row.rotor_type || '/';
                row.frequency = row.frequency || '/';
                row.air_direction = row.air_direction || '/';
                row.material = row.material || 'plastic';
                
                return row;
            });
        },
		
    };
	
	function do_changesearch() {
		$('.fixed-table-toolbar .search').html('<input type="text" id="model-search" class="form-control" placeholder="' + __('Enter Model') + '" autocomplete="off" data-toggle="dropdown"> <div style="width:100%;" id="model-dropdown" class="dropdown-menu w-100"></div>');
		
		let svg = '<button style="width:35px;height:33px;" class="btn btn-default show-filter d-flex justify-content-center align-items-center p-0" type="button" title="Show Filter">' +
					'<svg style="margin-top:5px;" xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" class="bi bi-search" viewBox="0 0 16 16">' +
					'<path d="M11.742 10.344a6.5 6.5 0 1 0-1.397 1.398h-.001q.044.06.098.115l3.85 3.85a1 1 0 0 0 1.415-1.414l-3.85-3.85a1 1 0 0 0-.115-.1zM12 6.5a5.5 5.5 0 1 1-11 0 5.5 5.5 0 0 1 11 0"/>' +
					'</svg></button>'
        $('button.show-filter').remove();            
		$('.fixed-table-toolbar > .btn-group').prepend(svg);
	}
	
	let si = setInterval( () => {
		
		if ( $('.fixed-table-toolbar .search').length == 0 ) {
			console.log($('.fixed-table-toolbar .search'));
			return false;
		} else {
			clearInterval(si);
		}
		
		let debounce = (fn, delay = 300) => {
			let timer;
			return function () {
				clearTimeout(timer);
				timer = setTimeout(() => fn.apply(this, arguments), delay);
			};
		};
		
		do_changesearch();
		
		// ①监听输入
		$(document).on('input focus', '#model-search', debounce(function (e) {
			let kw = $.trim(this.value);
			if (!kw) {
				$('#model-dropdown').empty().removeClass('show');
				return;
			}
			$.getJSON('/index/fan/search_model', {q: kw}, function (res) {
				if (!res.length) {
					$('#model-dropdown').html('<span class="dropdown-item disabled">No result</span>').addClass('show');
					return;
				}
				let html = res.map(i =>
					`<a class="dropdown-item viewdetails" href="/index/fan/detail/id/${i.id}" target="_blank">${i.fan_model}</a>`
				).join('');
				$('#model-dropdown').html(html).addClass('show');
			});
		}));
        
        $(document).on('keydown', '#model-search', function (e) {
            if (e.key === 'Enter' || e.keyCode === 13) {
                e.preventDefault();              // 阻止表单默认提交
                const kw = $.trim(this.value);   // 当前关键字
                if (!kw)    return;              // 空值直接返回

                // 把关键字放进隐藏字段，供 searchFans() 收集
                $('input.bootstrap-table-filter-control-fan_model').val(kw);

                // 调用既有搜索逻辑
                //Controller.searchFans();
                $('#fan-results-table').bootstrapTable('refresh', {pageNumber:1});
                
                // 关闭下拉
                //$('#model-dropdown').removeClass('show');
                $(document.body).trigger('click');
                console.log('#model-search');
                return false;
                // 不再手动 refresh，让 bootstrap-table 自己接管
                //$('input.bootstrap-table-filter-control-fan_model').val($.trim(this.value)).trigger('input');                // 触发列搜索
                //return false;// 阻止表单默认提交
            }
        });

		// ③点页面其它区域时隐藏下拉
		$(document).on('click', function (e) {
			if (!$(e.target).closest('#model-search').length) {
				$('#model-dropdown').removeClass('show');
			}
		});
		
		
		$(document).on('click', 'button.show-filter', function (e) {
			$('#fan-results-table thead tr:first .fht-cell').toggle();
            $('#fan-results-table').bootstrapTable('resetView');
		});
		$('button.show-filter').trigger('click');
		
    }, 129);
	
	setTimeout(() => {

		/* --------- 通用初始化函数 --------- */
		function initSlider(fieldName, range){
			const $input  = $("input[name='"+fieldName+"']");
			if(!$input.length) return;

			const $row    = $input.closest(".form-horizontal");
			const $unit   = $row.find("select").last();      // 同行最后一个 select 视为单位框
			const $scroll = $row.find(".scroll");
			const $bar    = $scroll.find(".bar");

			/* 动态放置轨道 */
			function placeScroll(){
				const offsetL = $input.position().left;
				const width   = $unit.position().left + $unit.outerWidth() - offsetL;
				$scroll.css({left: offsetL, width: width});
			}
			placeScroll(); $(window).on("resize", placeScroll);

			/* 数值 ←→ 像素互转 */
			function value2left(val){
				val = Math.max(Math.min(val, range[1]), range[0]);
				const track = $scroll.width() - $bar.outerWidth();
				return track * (val-range[0])/(range[1]-range[0]);
			}
			function left2value(left){
				const track = $scroll.width() - $bar.outerWidth();
				return Math.round(range[0] + left/track*(range[1]-range[0]));
			}

			/* 输入框 → bar  */
			function syncBar(){
				const v = parseInt($input.val(),10) || range[0];
				$bar.css("left", value2left(v));
			}
			syncBar();                     // 初始
			$input.on("input", syncBar);   // 手动编辑

			/* bar 拖动 */
			$bar.on("mousedown", function(e){
				e.preventDefault();
				const startX   = e.pageX;
				const startLeft= parseFloat($bar.css("left"));
				$(document).on("mousemove."+fieldName, function(ev){
					const dx   = ev.pageX - startX;
					const track= $scroll.width() - $bar.outerWidth();
					let   left = Math.max(0, Math.min(track, startLeft+dx));
					$bar.css("left", left);
					$input.val( left2value(left) );
				}).on("mouseup."+fieldName, function(){
					$(document).off("mousemove."+fieldName)
							   .off("mouseup."+fieldName);
				});
			});
			
			// 保存控制器实例，以便后续更新
			window.sliderControls[fieldName] = {
				updateRange: function(newRange) {
                    //  ranges[fieldName] = newRange;   // ① 报错行
                    // ① 同步到全局配置，便于别处复用
                    paramRanges[fieldName] = newRange;
                    // ② 同步到当前滑块闭包变量，让后面的算法用到新区间
                    range = newRange;
                    //console.log('$input1', $input.val())
					// 如果当前值超出新范围，调整到范围内
					let currentVal = parseInt($input.val(), 10) || 0;
                    if ( currentVal == 0 ) {
                                    
                    } else {
                        if (currentVal < newRange[0]) {
                            $input.val(newRange[0]);
                        } else if (currentVal > newRange[1]) {
                            $input.val(newRange[1]);
                        }
                    }

                    //console.log('$input2', $input.val())
                    // 重新定位滑块轨道（因为可能输入框位置变化）
                    placeScroll();
        
					syncBar(); // 立即刷新滑块位置
				},
				syncBar: syncBar
			};
		
		}

		/* ---------- 批量启用 ---------- */
		Object.entries(paramRanges).forEach(([k,v])=>initSlider(k,v));

				
	}, 555);

    Controller.scheduleLoadPQ = (function () {
        let timer = null;
        return function () {
            clearTimeout(timer);
            timer = setTimeout(() => Controller.loadTableFansPQData(), 300); // 300 ms 防抖
        };
    })();

    return Controller;
});
