<?php

namespace app\common\model;

use think\Model;

class OperationLog extends Model
{
    protected $name = 'operation_log';
    
    // 开启自动写入时间戳字段
    protected $autoWriteTimestamp = 'int';
    // 定义时间戳字段名
    protected $createTime = 'createtime';
    protected $updateTime = 'updatetime';

    // 定义字段类型
    protected $type = [
        'extra_data' => 'json'
    ];

    /**
     * 记录操作日志
     * @param string $modelName 模块名称
     * @param int $modelId 关联记录ID
     * @param string $action 操作类型
     * @param string $title 操作标题
     * @param string $content 操作内容
     * @param array $extraData 额外数据
     * @return bool|OperationLog
     */
    public static function record($modelName, $modelId, $action, $title, $content = '', $extraData = [])
    {
        $request = request();
        
        // 获取当前用户信息
        $adminInfo = session('admin');
        $userInfo = session('user');
        
        $data = [
            'model_name' => $modelName,
            'model_id' => $modelId,
            'action' => $action,
            'title' => $title,
            'content' => $content,
            'admin_id' => $adminInfo ? $adminInfo['id'] : 0,
            'admin_name' => $adminInfo ? $adminInfo['nickname'] : '',
            'user_id' => $userInfo ? $userInfo['id'] : 0,
            'user_name' => $userInfo ? $userInfo['nickname'] : '',
            'ip' => $request->ip(),
            'user_agent' => $request->header('User-Agent'),
            'extra_data' => $extraData,
        ];
        
        $log = new self();
        return $log->save($data) ? $log : false;
    }

    /**
     * 获取指定模块记录的日志
     * @param string $modelName 模块名称
     * @param int $modelId 记录ID
     * @param int $limit 限制数量
     * @return \think\Collection
     */
    public static function getModelLogs($modelName, $modelId, $limit = 50)
    {
        return self::where('model_name', $modelName)
            ->where('model_id', $modelId)
            ->order('createtime', 'desc')
            ->limit($limit)
            ->select();
    }

    /**
     * 获取操作类型列表
     * @return array
     */
    public static function getActionList()
    {
        return [
            'create' => '创建',
            'update' => '更新',
            'delete' => '删除',
            'upload' => '上传',
            'search' => '搜索',
            'replace' => '替换',
            'download' => '下载',
            'view' => '查看',
            'classify' => '分类',
            'login' => '登录',
        ];
    }

    /**
     * 获取操作人员信息
     * @return string
     */
    public function getOperatorAttr()
    {
        if ($this->admin_id > 0) {
            return $this->admin_name . '(管理员)';
        } elseif ($this->user_id > 0) {
            return $this->user_name . '(用户)';
        } else {
            return '系统';
        }
    }
}
