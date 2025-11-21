<?php

namespace app\index\controller;

use app\common\controller\Frontend;
use think\Cookie;
use think\Lang;
use think\Config;
use think\Db;

class Index extends Frontend
{

    protected $noNeedLogin = [];
    protected $noNeedRight = ['index'];
    protected $layout = '';
    
    public function _initialize()
    {
        parent::_initialize();
        
        // 检查并设置语言
        //$this->setLanguage();
    }
    //备份
    public function index2()
    {
        $currentLang = $this->request->param('lang', Config::get('default_lang'));
        
        // 获取所有风机类型及其对应语言信息
        $fanTypes = Db::table('fa_fan_type')
            ->alias('t')
            ->join('fa_fan_type_lang l', 't.id = l.fan_type_id')
            ->where('l.lang', $currentLang)
            ->field('t.id, t.image, l.name')
            ->select();
            
        // 获取所有不重复的额定电压
        $voltages = \app\common\model\FanProduct::getDistinctRatedVoltages();
        $this->assign('voltages', $voltages);
		
		// 获取所有不重复的电源类型
		$powerTypes = Db::name('fan_product')
			->field('powertype')
			->group('powertype')  // 使用group确保不重复
			->where('powertype', '<>', '')  // 排除空值
			->where('powertype', 'not null')  // 排除null值
			->order('powertype')  // 按字母顺序排序
			->column('powertype');
		
		$this->assign('powerTypes', $powerTypes);
		
		$fan = \app\common\model\FanProduct;
		
		$query = $fan->alias('p')
			->join('fan_type t', 'p.fan_type_id = t.id')
			->field('p.*, t.name as type_name');
		// 只显示状态为正常的产品
		$query->where('p.status', '1');
		
		// 排序
		$sort = 'fan_model';
		$order = 'asc';
		$query->order('p.' . $sort, $order);
		
		// 分页
		$page = 1;
		$limit = 100;
		
		$list = $query->page($page, $limit)->select();
	
		// 处理图片路径
		foreach ($list as &$item) {
			if ($item['product_images']) {
				$images = explode(',', $item['product_images']);
				$item['image'] = isset($images[0]) ? $images[0] : '';
			} else {
				$item['image'] = '/assets/img/placeholder.png';
			}
		}
		
        $this->assign('title', 'Home');
        $this->assign('plists', $list);
        $this->assign('fanTypes', $fanTypes);
        $this->assign('currentLang', $currentLang);
        
        return $this->view->fetch();
    }
	//2025.04.26新增
	public function index()
	{
		//$currentLang = $this->request->param('lang', Config::get('default_lang'));
        $currentLang = Lang::detect();
		
		// 获取所有风机类型及其对应语言信息
		$fanTypes = Db::table('fa_fan_type')
			->alias('t')
			->join('fa_fan_type_lang l', 't.id = l.fan_type_id')
			->where('l.lang', $currentLang)
			->field('t.id, t.image, l.name')
            ->order('t.weigh', 'desc')
			->select();
			
		// 获取所有不重复的额定电压
		$voltages = \app\common\model\FanProduct::getDistinctRatedVoltages();
		$this->assign('voltages', $voltages);
		
		// 获取所有不重复的电源类型
		$powerTypes = Db::name('fan_product')
			->field('powertype')
			->group('powertype')
			->where('powertype', '<>', '')
			->where('powertype', '<>', '-')
			->where('powertype', 'not null')
			->order('powertype')
			->column('powertype');
		
		$this->assign('powerTypes', $powerTypes);
        
		// 获取所有不重复的电源类型
		$fanSeries = Db::name('fan_product')
			->field('custom_str3')
			->group('custom_str3')
			->where('custom_str3', '<>', '')
			->where('custom_str3', '<>', '-')
			->where('custom_str3', 'not null')
			->order('custom_str3')
			->column('custom_str3');
            
        $this->assign('fanSeries', $fanSeries);    
		
		// 获取所有风机类型ID
		$fanTypeIds = array_column($fanTypes, 'id');
		
		// 初始化结果数组
		$allFans = [];
		
		// 对每种风机类型，获取100条数据
		foreach ($fanTypeIds as $typeId) {
			$fans = Db::name('fan_product')
				->alias('p')
				->join('fan_type t', 'p.fan_type_id = t.id')
				->join('fan_type_lang tl', 'tl.fan_type_id = t.id')
				->field('p.*, tl.name as type_name, t.image as fanimage')
				->where('p.fan_type_id', $typeId)
				->where('tl.lang', $currentLang)
				->where('p.status', '1')
				->order('p.fan_model', 'asc')
				->limit(100)
				->select();
			
			// 处理图片路径
			foreach ($fans as &$item) {
				$item['image'] = $item['fanimage'];
				if ($item['product_images']) {
					$images = explode(',', $item['product_images']);
					$image = isset($images[0]) ? $_SERVER['DOCUMENT_ROOT']. '/assets/fan/main/' . $images[0] . '.jpg' : '';
					$item['image'] = file_exists($image) ? '/assets/fan/main/' . $images[0] . '.jpg' : $item['fanimage'];
				}
			}
			
			// 将当前类型的风机添加到总结果中
			$allFans = array_merge($allFans, $fans);
		}
		
		// 获取最小和最大风量值
		$minMaxFlow = Db::name('fan_product')
			->field('MIN(air_flow) as min_flow, MAX(air_flow) as max_flow')
			->where('air_flow', '>', 0) // 排除零值
			->find();
		
		// 将范围数据传递给视图
		$this->assign('air_flow_range', [
			'min' => intval($minMaxFlow['min_flow']), 
			'max' => intval($minMaxFlow['max_flow'])
		]);
		
		$this->assign('title', 'Home');
		$this->assign('plists', $allFans);
		$this->assign('fanTypes', $fanTypes);
		$this->assign('currentLang', $currentLang);
		$this->assign('totalCount', count($allFans));
		
		return $this->view->fetch();
	}

    /**
     * 检查并设置语言
     * 如果用户没有选择语言，则设置为英语
     */
    protected function setLanguage()
    {
        // 检查用户是否主动选择过语言
        $userLanguageSelected = Cookie::get('user_language_selected');
        
        // 如果用户没有主动选择语言，则设置为英语
        if (empty($userLanguageSelected)) {
            Lang::range('en');
            
            Cookie::set('user_language_selected', '1', ['expire' => 30*86400]);
        }
    }

}
