<?php

namespace app\common\model;

use think\Model;
use think\Db;

class Wiring extends Model
{
    

    // 表名
    protected $name = 'fan_wiring';
    // 自动写入时间戳字段
    protected $autoWriteTimestamp = 'int';

    // 定义时间戳字段名
    protected $createTime = 'createtime';
    protected $updateTime = 'updatetime';
    
    

    /**
     * 将某个 wire_mode 渲染成 <table> 供 PDF 使用
     * 访问示例：/admin/fan.wiringdiagram/render?wire_mode=X2A700
     */
    public function render($wire_mode = '')
    {
        $wire_mode = $wire_mode ?: $this->request->get('wire_mode');
        if (!$wire_mode) $this->error('缺少 wire_mode');

        $rows = Db::name('fan_wiring')
            ->where(['wire_mode'=>$wire_mode,'status'=>'1'])
            ->select();

        if (!$rows) {
            return '';
        }

        $html = $this->buildHtmlTable($rows, $wire_mode);

        // 直接输出 html 字符串；如果需要渲染模板可改为 $this->view->assign(...)
        return $html;
    }

    /**
     * 构造带 rowspan 的 HTML
     * - wire_type 行合并
     * - 如果同组的 note 完全相同，也做 rowspan
     */
    private function buildHtmlTable($rows, $wire_mode)
    {
        /* 统计 rowspan */
        $grouped = [];
        foreach ($rows as $r) $grouped[$r['wire_type']][] = $r;

        $thead = '<tbody>';

        $tbody = '';
        foreach ($grouped as $type => $list) {
            $typeRows = count($list);

            // 判断 note 是否全部一致
            $noteSame = count(array_unique(array_column($list,'note'))) === 1;
            $noteRowspan = $noteSame ? $typeRows : 1;

            foreach ($list as $idx => $item) {
                $tbody .= '<tr>';

                /* 合并 Wire Type */
                if ($idx === 0) {
                    $tbody .= '<td rowspan="'.$typeRows.'">'. __($type) .'</td>';
                }

                $tbody .= '<td>'.htmlentities( __($item['signal']) ).'</td>';
                $tbody .= '<td>'.htmlentities( __($item['colour']) ).'</td>';
                $tbody .= '<td>'.htmlentities( __($item['assignment_function']) ).'</td>';

                /* 合并 Note（可选）*/
                if ($noteSame) {
                    if ($idx === 0) $tbody .= '<td rowspan="'.$noteRowspan.'">'.htmlentities( __($item['note']) ).'</td>';
                } else {
                    $tbody .= '<td>'.htmlentities( __($item['note']) ).'</td>';
                }

                $tbody .= '</tr>';
            }
        }

        $tfoot = '</tbody>';
        return $thead.$tbody.$tfoot;
    }
}
