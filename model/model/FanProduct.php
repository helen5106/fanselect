<?php

namespace app\common\model;

use think\Model;

class FanProduct extends Model
{
    // 表名
    protected $name = 'fan_product';
    
    // 自动写入时间戳字段
    protected $autoWriteTimestamp = 'int';

    // 定义时间戳字段名
    protected $createTime = 'createtime';
    protected $updateTime = 'updatetime';
    
    // 追加属性
    protected $append = [
        'status_text'
    ];
    
    // 状态映射
    public static $statusList = [
        '0' => '隐藏',
        '1' => '正常'
    ];
    
    public function getStatusTextAttr($value, $data)
    {
        return isset($data['status']) ? self::$statusList[$data['status']] : '';
    }
    
    // 关联风机类型
    public function fanType()
    {
        return $this->belongsTo('FanType', 'fan_type_id', 'id');
    }
    
    /**
     * 获取所有不重复的额定电压
     * @return array
     */
    public static function getDistinctRatedVoltages()
    {
        $voltages = self::distinct(true)
            ->where('rated_voltage', 'not null')
            ->order('rated_voltage', 'asc')
            ->column('rated_voltage');
            
        return $voltages;
    }

    protected static function init()
    {
        // 新增 & 更新前都做一次规范化
        self::beforeInsert(function ($model) {
            self::normalizeAcFields($model);
        });
        self::beforeUpdate(function ($model) {
            self::normalizeAcFields($model);
        });
    }

    /**
     * 规范化 AC 风机的多值字段
     *
     * 规则：
     * - motor_type == 'AC' 且传入值包含分隔符：最后一个值写入原字段，其余值（保留顺序）写入 *_ac
     * - motor_type != 'AC'：所有 *_ac 清空，原字段只保留一个值（取最后一个非空值，避免误传多值）
     */
    protected static function normalizeAcFields(Model $model)
    {
        // 五组需要处理的字段映射：原字段 => 扩展字段
        $pairs = [
            'air_flow'      => 'air_flow_ac',
            'air_pressure'  => 'air_pressure_ac',
            'rated_power'   => 'rated_power_ac',
            'rated_current' => 'rated_current_ac',
            'rated_speed'   => 'rated_speed_ac',
        ];

        // 当前 motor_type（注意：导入时可能是字符串）
        $motorType = strtoupper(trim((string)($model->getAttr('motor_type') ?: '')));

        foreach ($pairs as $base => $ac) {
            // 只有当本次写入（insert/update）里包含该字段时才处理，避免无关更新把已有数据意外覆盖
            if (!$model->has($base) && !$model->has($ac)) {
                continue;
            }

            $raw = (string)$model->getAttr($base);  // 原始输入，例如 "1000,2000,3000"
            [$main, $others] = self::splitMultiValues($raw);

            if ($motorType === 'AC') {
                // AC：最后一个落原字段，其余合并进 *_ac（可为空字符串）
                $model->setAttr($base, $main !== '' ? $main : null);
                $model->setAttr($ac,   $others !== '' ? $others : null);
            } else {
                // DC / EC：保持单值语义，扔掉其它；*_ac 清空
                $model->setAttr($base, $main !== '' ? $main : null);
                $model->setAttr($ac,   null);
            }
        }
    }

    /**
     * 把用户可能传入的“多值字符串”切分成 [最后一个值, 其余值拼接]
     * 支持的分隔符：英文逗号, 中文逗号，顿号、分号、竖线、空格、TAB、全角空格、斜杠
     * 会自动去除空项与首尾空白，保持原始顺序
     *
     * 例如：
     *  "1000,2000,3000" -> ["3000", "1000,2000"]
     *  " 500； 600  700 " -> ["700", "500,600"]
     *  "800" -> ["800",""]
     */
    protected static function splitMultiValues(string $value): array
    {
        // 统一替换为英文逗号，便于后续处理
        $normalized = strtr($value, [
            '，' => ',', '、' => ',', '；' => ',', ';' => ',', '|' => ',',
            ' ' => ',', "\t" => ',', '　' => ',', '／' => '/',  // 全角空格与斜杠考虑
        ]);
        // 斜杠也按分隔理解
        $normalized = str_replace(['/', '／'], ',', $normalized);

        // 分隔并清洗
        $parts = array_values(array_filter(array_map(function ($s) {
            return trim($s);
        }, explode(',', $normalized)), function ($s) {
            return $s !== '';
        }));

        if (empty($parts)) {
            return ['', ''];
        }
        if (count($parts) === 1) {
            return [$parts[0], ''];
        }

        // 最后一个为主，其余按照原顺序合并
        $main   = array_pop($parts);
        $others = implode(',', $parts);

        return [$main, $others];
    }
}
