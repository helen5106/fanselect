<?php

namespace app\common\model;

use think\Model;

class FanPqdata extends Model
{
    // 表名
    protected $name = 'fan_pqdata';
    
    // 自动写入时间戳字段
    protected $autoWriteTimestamp = 'int';

    // 定义时间戳字段名
    protected $createTime = 'createtime';
    protected $updateTime = 'updatetime';
      
    
    // 关联风机产品
    public function fanProduct()
    {
        return $this->belongsTo('FanProduct', 'fan_product_id');
    }
    
}