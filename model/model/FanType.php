<?php

namespace app\common\model;

use think\Model;

class FanType extends Model
{
    // 表名
    protected $name = 'fan_type';
    
    // 自动写入时间戳字段
    protected $autoWriteTimestamp = 'int';

    // 定义时间戳字段名
    protected $createTime = 'createtime';
    protected $updateTime = 'updatetime';
    
    // 关联风机产品
    public function products()
    {
        return $this->hasMany('FanProduct', 'fan_type_id', 'id');
    }
}
