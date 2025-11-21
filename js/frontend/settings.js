// public/assets/js/frontend/settings.js

define(['jquery', 'bootstrap', 'fast'], function ($, undefined, Fast) {
    var UnitSettings = {
        // 单位转换公式
        conversionFactors: {
            // 流量单位转换 (基准: m3/h)
            flow: {
                'm³/h': 1,
                'm³/s': 1/3600,
                'l/s': 1000/3600,
                'CFM': 0.588578
            },
            // 压力单位转换 (基准: Pa)
            pressure: {
                'Pa': 1,
                'kPa': 0.001,
                'bar': 0.00001,
                'mbar': 0.01,
                'inHG': 0.000295299830714,
                'inH₂O': 0.00401463,
                'psi': 0.000145038,
                'ftWC': 0.00033455
            },
            // 功率单位转换 (基准: W)
            power: {
                'W': 1,
                'kW': 0.001,
                'hp': 0.00134102,
                'BTU/h': 3.41214
            },
            // 温度单位转换 (特殊处理)
            temperature: {
                'C': function(c) { return c; },
                'F': function(c) { return c * 9/5 + 32; }
            },
            // 温度单位反向转换
            temperatureReverse: {
                'C': function(f) { return f; },
                'F': function(f) { return (f - 32) * 5/9; }
            },
            // 密度单位转换 (基准: kg/m3)
            density: {
                'kg/m³': 1,
                'lb/ft³': 0.062428
            },
            // 长度单位转换 (基准: mm)
            dimension: {
                'mm': 1,
                'cm': 0.1,
                'in': 0.0393701,
                'ft': 0.00328084
            },
            // 质量单位转换 (基准: kg)
            mass: {
                'kg': 1,
                'lb': 2.20462
            }
        },
        
        // 存储原始值的对象
        originalValues: {},
        
        init: function () {
			//console.log(this);
            // 确保设置按钮的父容器有相对定位
            $('#btn-settings').parent().css('position', 'relative');
            
            // 设置面板的显示和隐藏
            $('#btn-settings').on('click', function (e) {
                e.preventDefault();
                e.stopPropagation();

                // 切换设置面板显示状态
                $('#settings-panel').toggle();
                
                // 正确定位设置面板
                $('#settings-panel').is(':visible') && UnitSettings.positionPanel();
            });
            
            // 点击页面其他地方隐藏设置面板
            $(document).on('click', function (e) {
                if (!$(e.target).closest('#settings-panel').length && !$(e.target).closest('#btn-settings').length) {
                    $('#settings-panel').hide();
                }
            });
            
            // 阻止点击面板内部导致面板关闭
            $(document).on('click', '#settings-panel', function(e) {
                e.stopPropagation();
            });
			
            // 首页单位筛选
            $('select[name="flowunit"]').on('change', function(e) {
                let $this = $(this);
				let flow = $this.val();
				let unitg = $('.unit-group').find('button[data-value="' + flow +'"]');
				if (unitg.length) {
					unitg.trigger('click');
					$('#apply-settings').trigger('click');
				}
            });
            // 首页单位筛选
            $('select[name="pressunit"]').on('change', function(e) {
                let $this = $(this);
				let flow = $this.val();
				let unitg = $('.unit-group').find('button[data-value="' + flow +'"]');
				if (unitg.length) {
					unitg.trigger('click');
					$('#apply-settings').trigger('click');
				}
            });
            // 详情页单位筛选
            $('select[name="temperatureunit"]').on('change', function(e) {
                let $this = $(this);
				let flow = $this.val();
				let unitg = $('.unit-group').find('button[data-value="' + flow +'"]');
				if (unitg.length) {
					unitg.trigger('click');
					$('#apply-settings').trigger('click');
				}
            });
            $('select[name="densityunit"]').on('change', function(e) {
                let $this = $(this);
				let flow = $this.val();
				let unitg = $('.unit-group').find('button[data-value="' + flow +'"]');
				if (unitg.length) {
					unitg.trigger('click');
					$('#apply-settings').trigger('click');
				}
            });
            
            // 单位选择
            $('.unit-group button').on('click', function () {
                var $this = $(this);
                var $group = $this.parent();
                
                // 移除同组中的所有active类
                $group.find('button').removeClass('active btn-primary').addClass('btn-default');
                
                // 给当前点击的按钮添加active类
                $this.removeClass('btn-default').addClass('active btn-primary');
            });
            
            // 应用设置
            $('#apply-settings').on('click', function () {
                var settings = {};
                var oldSettings = {};
                
                // 获取旧设置
                try {
                    var savedSettings = localStorage.getItem('unitSettings');
                    if (savedSettings) {
                        oldSettings = JSON.parse(savedSettings);
                    }
                } catch (e) {
                    console.error('Failed to parse saved settings:', e);
                }
                
                // 收集所有单位组的选中值
                $('.unit-group').each(function () {
                    var unitType = $(this).data('unit-type');
                    var selectedValue = $(this).find('button.active').data('value');
                    settings[unitType] = selectedValue;
                });
                
                // 保存设置到本地存储
                localStorage.setItem('unitSettings', JSON.stringify(settings));
                
                // 应用设置到当前页面
                UnitSettings.applyUnitSettings(settings, oldSettings);
                
                // 显示成功消息
                Fast.api.toastr.success(__('Unit settings updated'));
                
                // 隐藏设置面板
                $('#settings-panel').hide();
            });
            
            // 监听窗口大小变化，重新定位面板
            $(window).on('resize', function() {
                if ($('#settings-panel').is(':visible')) {
                    UnitSettings.positionPanel();
                }
            });
            
            // 页面加载时保存原始值
            this.saveOriginalValues();
            
            // 页面加载时应用保存的设置
            this.loadSavedSettings();
            
            // 将设置面板移动到正确的位置
            this.moveSettingsPanel();
        },
        
        // 保存表单中的原始值
        saveOriginalValues: function() {
            $('#fan-filter-form input[type="number"]').each(function() {
                var $input = $(this);
                var name = $input.attr('name');
                var value = $input.val();
                if (value) {
                    UnitSettings.originalValues[name] = typeof $input.data('type') != 'undefined' ? parseInt(value) : parseFloat(value);
                }
            });
        },
        
        // 移动设置面板到导航栏内的正确位置
        moveSettingsPanel: function() {
            // 检查设置面板是否已经在正确位置
            var $settingsBtn = $('#btn-settings');
            var $settingsPanel = $('#settings-panel');
            
            // 如果设置面板不在按钮的父元素内，则移动它
            if ($settingsPanel.parent().get(0) !== $settingsBtn.parent().get(0)) {
                $settingsPanel.detach().appendTo($settingsBtn.parent());
            }
        },
        
        // 定位面板到按钮下方
        positionPanel: function() {
            var $button = $('#btn-settings');
            var $panel = $('#settings-panel');
            
            if ($button.length && $panel.length) {
                // 获取按钮位置信息
                var buttonPosition = $button.position();
                var buttonHeight = $button.outerHeight();
                var buttonWidth = $button.outerWidth();
                var panelWidth = $panel.outerWidth();
                
                // 在导航栏内定位面板
                $panel.css({
                    'position': 'absolute',
                    'top': buttonHeight + 'px',
                    'right': '0px' // 右对齐
                });
                
                // 检查面板是否会超出视口右侧
                var rightEdge = $button.offset().left + panelWidth;
                var windowWidth = $(window).width();
                
                if (rightEdge > windowWidth) {
                    // 调整面板位置，使其不超出视口
                    var adjustment = rightEdge - windowWidth + 10; // 10px的安全边距
                    $panel.css('right', adjustment + 'px');
                }
            }
        },
        
        // 加载保存的设置
        loadSavedSettings: function () {
            //var savedSettings = localStorage.getItem('unitSettings');
            var savedSettings = UnitSettings.getCurrentUnits();
            if (savedSettings) {
                try {
                    //var settings = JSON.parse(savedSettings);
                    var settings = savedSettings;
                    
                    // 应用保存的设置到按钮状态
                    for (var unitType in settings) {
                        var value = settings[unitType];
                        var $group = $('.unit-group[data-unit-type="' + unitType + '"]');
                        
                        $group.find('button').removeClass('active btn-primary').addClass('btn-default');
                        $group.find('button[data-value="' + value + '"]').removeClass('btn-default').addClass('active btn-primary');
                        
                        unitType == 'flow' && $('select[name="flowunit"]').val(value);
                        unitType == 'pressure' && $('select[name="pressunit"]').val(value);
                        unitType == 'temperature' && $('select[name="temperatureunit"]').val(value);
                        unitType == 'density' && $('select[name="densityunit"]').val(value);
                        
                    }
                    
                    // 应用设置到当前页面
                    this.applyUnitSettings(settings, this.currentUnits);
                } catch (e) {
                    console.error('Failed to parse saved settings:', e);
                }
            }
        },
        
        // 将设置应用到页面上的单位显示和输入值
        applyUnitSettings: function (settings, oldSettings) {
            // 更新单位显示
            this.updateUnitLabels(settings);
            
            // 更新输入框的值
            this.updateInputValues(settings, oldSettings);

            // 触发单位更改事件
            setTimeout(function () {$(document).trigger('units:changed', [settings, oldSettings]);}, 666);
        },
        
        // 更新单位标签
        updateUnitLabels: function(settings) {
            // 更新流量单位
            if (settings.flow) {
                $('.flowunit').text(settings.flow);
            }
            
            // 更新压力单位
            if (settings.pressure) {
                $('.pressunit').text(settings.pressure);
            }
            
            // 更新功率单位
            if (settings.power) {
                $('.powerunit').text(settings.power);
            }
            
            // 更新温度单位
            if (settings.temperature) {
                $('.tempunit').text('°' + settings.temperature);
            }
            
            // 更新密度单位
            if (settings.density) {
                $('.densityunit').text(settings.density);
            }
            
            // 更新长度单位
            if (settings.dimension) {
                $('.sizeunit').text(settings.dimension);
            }
            
            // 更新质量单位
            if (settings.mass) {
                $('.massunit').text(settings.mass);
            }
        },
        
        // 更新输入框的值
        updateInputValues: function(newSettings, oldSettings) {
            var self = this;
            
            // 处理输入框的值转换
            $('#fan-filter-form input[type="number"]').each(function() {
                var $input = $(this);
                var name = $input.attr('name');
                var currentValue = $input.val();

                // 如果有值才进行转换
                if (currentValue) {
                    var value = parseFloat(currentValue);
                    var newValue = value;
                    
                    // 根据输入框名称确定单位类型
                    var unitType = self.getUnitTypeByInputName(name);
                    
                    if (unitType && newSettings[unitType] && oldSettings[unitType]) {
                        // 如果单位类型存在且新旧设置都有该单位类型
                        newValue = self.convertValue(value, oldSettings[unitType], newSettings[unitType], unitType);
                    } else if (unitType && newSettings[unitType] && self.originalValues[name]) {
                        // 使用原始值进行转换
                        var baseValue = self.originalValues[name];
                        var baseUnit = self.getBaseUnitByType(unitType);
                        newValue = self.convertValue(baseValue, baseUnit, newSettings[unitType], unitType);
                    }
                    
                    // 更新输入框的值，保留两位小数
					if ('flow' == unitType) {
						$input.val(newSettings[unitType] == 'm³/h' ? parseInt(newValue) : newValue.toFixed(3));
					} else {
						typeof $input.data('type') != 'undefined' ? $input.val(parseInt(newValue)) : $input.val(newValue.toFixed(2));
					}
                }
            });
        },
        
        // 根据输入框名称获取单位类型
        getUnitTypeByInputName: function(name) {
            // 根据输入框名称映射到单位类型
            var mapping = {
                'air_flow': 'flow',
                'air_pressure': 'pressure',
                'rated_power': 'power',
                'operating_temp': 'temperature',
                'rotor_outline': 'dimension',
                'outline_length': 'dimension',
                'outline_width': 'dimension',
                'outline_height': 'dimension',
                'impeller_diameter': 'dimension',
                'impeller_height': 'dimension',
                'inlet_diameter': 'dimension'
            };
            
            return mapping[name];
        },
		
        currentUnits: {
			'flow': 'm³/h',
			'pressure': 'Pa',
			'power': 'W',
			'temperature': 'C',
			'density': 'kg/m³',
			'dimension': 'mm',
			'mass': 'kg'
        },
		
        // 获取单位类型的基本单位
        getBaseUnitByType: function(unitType) {
            var baseUnits = UnitSettings.currentUnits;
            
            return baseUnits[unitType];
        },
        
        // 转换值 2025.05.01
        convertValue: function(value, fromUnit, toUnit, unitType) {
            let v = value - 0;
            // 如果单位相同，不需要转换
            if (fromUnit === toUnit) {
                return v;
            }
            
            // 特殊处理温度转换
            if (unitType === 'temperature') {
                // 先转换为基准单位C
                var celsiusValue = (fromUnit === 'C') ? 
                    v : 
                    this.conversionFactors.temperatureReverse[fromUnit](v);
                
                // 再从基准单位转换为目标单位
                return this.conversionFactors.temperature[toUnit](celsiusValue);
            }
            
            // 其他单位转换
            var factors = this.conversionFactors[unitType];
            if (factors) {
                // 先转换为基准单位
                var baseValue = v / factors[fromUnit];
                // 再从基准单位转换为目标单位
                return baseValue * factors[toUnit];
            }
            
            return v;
        },

        // 获取当前单位设置
        getCurrentUnits: function () {
			
            var savedUnits = localStorage.getItem('unitSettings');
            
            if (savedUnits) {
                try {
                    return JSON.parse(savedUnits);
                } catch (e) {
                    console.error('Error parsing saved units:', e);
                }
            }
			
            return UnitSettings.currentUnits;
        },
		
      
        // 流量单位转换方法
        convertM3hToCFM: function (value) {
            return value * 0.5886;
        },
        
        convertM3hToLs: function (value) {
            return value * 0.2778;
        },
        
        // 压力单位转换方法
        convertPaToMmH2O: function (value) {
            return value * 0.102;
        },
        
        convertPaToInH2O: function (value) {
            return value * 0.004;
        },
        
        // 获取流量单位
        getFlowUnit: function () {
            let c = UnitSettings.getCurrentUnits();
            return c.flow || 'm³/h';
        },
        
        // 获取压力单位
        getPressureUnit: function () {
            let c = UnitSettings.getCurrentUnits();
            return c.pressure || 'Pa';
        },
        
    };

    return UnitSettings;
});
