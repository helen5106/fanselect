<?php
namespace app\index\controller;

use app\common\controller\Frontend;
use app\common\model\Attachment;
use think\Cookie;
use think\Lang;
use think\Config;
use think\Db;
use think\Exception;
use think\Request;
use PhpOffice\PhpWord\TemplateProcessor;
use PhpOffice\PhpWord\IOFactory;
use PhpOffice\PhpWord\Settings;
use Endroid\QrCode\QrCode;
use Endroid\QrCode\Writer\PngWriter;
use Endroid\QrCode\Encoding\Encoding;
use app\common\model\Wiring;
use app\admin\model\fan\ProductLog;

use PhpOffice\PhpSpreadsheet\Style\NumberFormat;
use PhpOffice\PhpSpreadsheet\Cell\DataType;

class Fan extends Frontend
{
    protected $noNeedLogin = [];
    protected $noNeedRight = [
        'index', 
        'tr_wiring', 
        'search', 
        'detail', 
        'getPQData', 
        'getFanInfo', 
        'compare', 
        'fanwall', 
        'configure', 
        
        'fwt', 
        'saveSelection',
        'exportExcel',
        'previewLayout',
        'deleteSelection',
        'exportFanWallExcel',
        
        'getMultipleFansPQData',
        'search_model', 
        'generateSpecPdf', 
        'exportPQ'
    ];
    protected $layout = 'default';
    
    protected $model = null;
    protected $userAuth = null;
    
    public function _initialize()
    {
        parent::_initialize();
        $this->userAuth = \app\common\library\Auth::instance();
        $this->model = model('FanProduct');
		
		Settings::setPdfRenderer(
			Settings::PDF_RENDERER_MPDF,                       // ① 渲染器类型常量
			ROOT_PATH . 'vendor/mpdf/mpdf'                    // ② 库所在目录
		);
    }
    
    /**
     * 风机筛选首页
     */
    public function index()
    {
        // 获取所有风机类型
        $fanTypes = model('FanType')->select();
        $this->assign('fanTypes', $fanTypes);
        $this->assign('title', 'Fan Details');
        return $this->view->fetch();
    }

    /**
     * 扫描 fan_wiring 表，把 3 个字段写入多语言文件
     * 返回：各语言 → 本次新增的“原文字符串”列表
     */
    public function tr_wiring()
    {
        // 需要写入的语言
        $langs = ['zh-cn', 'ru','es','ko'];

        // 1. 取唯一文本
        $records = Db::name('fan_wiring')
            ->field('wire_type, colour, assignment_function')
            ->select();

        $texts = [];
        foreach ($records as $row) {
            foreach (['wire_type', 'colour', 'assignment_function'] as $f) {
                $val = trim($row[$f]);
                $val && $texts[] = $val;
            }
        }
        $texts = array_unique($texts);

        // 2. 收集“新增条目”
        $added = array_fill_keys($langs, []);   // 现在是数组而不是 0

        foreach ($langs as $lang) {
            foreach ($texts as $str) {
                // ⬇️ 第三个参数指定语言，不影响全局
                if (__($str, [], $lang) === $str) {
                    $added[$lang][] = $str;     // 记录下来
                }
            }
        }

        //return json(['code' => 1, 'data' => $added, 'msg' => 'success']);
        return '
        <style>
            body { font-family: Arial; text-align: center; padding: 50px; }
            .progress-bar { 
                width: 100%; 
                height: 20px; 
                background: #f0f0f0; 
                border-radius: 10px; 
                overflow: hidden; 
                margin: 20px 0;
            }
            .progress { 
                height: 100%; 
                background: #4CAF50; 
                transition: width 0.1s; 
            }
        </style>
        <div>
            <h2>✓ 操作成功</h2>
            <p>窗口将在 <strong id="countdown">5</strong> 秒后自动关闭</p>
            <div class="progress-bar">
                <div class="progress" id="progress"></div>
            </div>
            <button onclick="window.close()">立即关闭</button>
        </div>
        <script>
        var seconds = 5;
        var countdown = document.getElementById("countdown");
        var progress = document.getElementById("progress");

        progress.style.width = "100%";

        var timer = setInterval(function() {
            seconds--;
            countdown.textContent = seconds;
            progress.style.width = (seconds / 5 * 100) + "%";
            
            if (seconds <= 0) {
                clearInterval(timer);
                window.close();
            }
        }, 1000);
        </script>';

    }


    /**
     * Save base64 image to temporary file
     */
    private function saveBase64Image($base64Data, $filename)
    {
        if (empty($base64Data)) {
            return null;
        }
        
        // Extract image data from base64 string
        $imageData = base64_decode(str_replace('data:image/png;base64,', '', $base64Data));
        
        // Create temporary file
        $tempPath = RUNTIME_PATH . 'temp/' . $filename . '_' . uniqid('', true) . '.png';
        
        // Ensure directory exists
        if (!is_dir(dirname($tempPath))) {
            mkdir(dirname($tempPath), 0755, true);
        }
        
        // Save image to file
        file_put_contents($tempPath, $imageData);
        
        return $tempPath;
    }
    
    /**
     * 根据最大宽高限制计算图片的新尺寸（保持比例）
     *
     * @param int $maxW  最大宽度 (px)  默认 500
     * @param int $maxH  最大高度 (px)  默认 450
     * @return array ['width'=>新宽度, 'height'=>新高度]
     */
    private function calcScaledSize(string $imagePath, int $maxW = 515, int $maxH = 510): array
    {
        // ------- 1. 读取原始尺寸 -------
        $info = getimagesize($imagePath);
        if ($info === false) {
            return ['width' => $maxW, 'height' => $maxH];
        }
        
        $origW = $info[0];
        $origH = $info[1];

        // 如是 JPEG，还要考虑 EXIF Orientation=6/8 时宽高互换
        if ($info[2] === IMAGETYPE_JPEG && function_exists('exif_read_data')) {
            $exif = @exif_read_data($imagePath);
            if (!empty($exif['Orientation']) && ($exif['Orientation'] == 6 || $exif['Orientation'] == 8)) {
                // 旋转 90° 的情况下宽高颠倒
                [$origW, $origH] = [$origH, $origW];
            }
        }

        // 已经符合？不动
        if ($origW <= $maxW && $origH <= $maxH) {
            return ['width' => $origW, 'height' => $origH];
        }

        // 只有宽超限
        if ($origH <= $maxH && $origW > $maxW) {
            $scale = $maxW / $origW;
            return ['width' => $maxW, 'height' => (int) round($origH * $scale)];
        }

        // 只有高超限
        if ($origW <= $maxW && $origH > $maxH) {
            $scale = $maxH / $origH;
            return ['width' => (int) round($origW * $scale), 'height' => $maxH];
        }

        // 双边都超：取更小的缩放比
        $scale = min($maxW / $origW, $maxH / $origH);
        return ['width' => (int) round($origW * $scale), 'height' => (int) round($origH * $scale)];
    }

    /**
     * 生成风机规格PDF
     */
    public function generateSpecPdf()
    {
        global $density, $units, $opvsp, $opdata, $opdata3v, $opdata5v, $opdata8v, $accessories, $connectortxt;
        
        // 未登录或没权限都会返回 false
        if (!$this->auth->check('fan/downloadspec')) {
            $this->error(__('You have no permission'));
        }
    
        $id = $this->request->post('id/d', 0);
        if (!$id) {
            $this->error(__('Fan ID not provided'));
        }
        
        $currentLang = Lang::detect();//Cookie::get('user_language_selected') ?? 
        
        // 获取布局选项
        $layout = $this->request->post('layout', 'simple');
        $contentOptions = explode(',', $this->request->post('content_options', ''));
        
        $density = $this->request->post('density', '1.204');
        
        $connectortxt = $this->request->post('connectortxt', '');
        $postacc = $this->request->post('acclist', '');
        $accessories = explode(',', $postacc);
        
        $units = $this->request->post('units', '[]');
        $units = json_decode(html_entity_decode($units), true);
        
        $opdata = $this->request->post('opdata', '[]');
        $opdata = json_decode(html_entity_decode($opdata), true);
        $opvsp = $this->request->post('opvsp', '10');

        $opdata3v = $this->request->post('opdata3v', '[]');
        $opdata3v = json_decode(html_entity_decode($opdata3v), true);
        
        $opdata5v = $this->request->post('opdata5v', '[]');
        $opdata5v = json_decode(html_entity_decode($opdata5v), true);
        
        $opdata8v = $this->request->post('opdata8v', '[]');
        $opdata8v = json_decode(html_entity_decode($opdata8v), true);
        
        // 获取风机数据
        $fan = $this->model->alias('p')
            ->join('fan_type_lang t', 'p.fan_type_id = t.fan_type_id')
            ->join('fan_type ft', 'p.fan_type_id = ft.id')
            ->field('p.*, t.name as type_name, ft.image as fanimage')
            ->where('p.id', $id)
            ->where('t.lang', $currentLang)
            ->find();
        
        if (!$fan) {
            $this->error(__('Fan not found'));
        }
        
        
        // 处理上传的图表图像
        $pqChartImage = $this->request->post('pq_chart');
        $powerChartImage = $this->request->post('power_chart');
        $efficiencyChartImage = $this->request->post('efficiency_chart');

        // 保存base64图像到临时文件
        //$pqChartPath = $this->saveBase64Image($pqChartImage, 'pq_chart_' . $id);
        //$powerChartPath = $this->saveBase64Image($powerChartImage, 'power_chart_' . $id);
        //$efficiencyChartPath = $this->saveBase64Image($efficiencyChartImage, 'efficiency_chart_' . $id);

             
        // 批量获取所有需要的图片信息
        $fanModels      = [$fan['product_images']];
        $circuitModels = [$fan['circuit_image']];
        $outlineModels = [$fan['outline_image']];

        // 批量查询图片
        $mainImages = $this->getMainImages($fanModels);
        $circuitImages = $this->getCircuitImages($circuitModels);
        $outlineImages = $this->getOutlineImages($outlineModels);

        // 处理图片路径

        $fanModel = $fan['product_images'];
        $circuitModel = $fan['circuit_image'];
        $outlineModel = $fan['outline_image'];
        
        // 设置默认图片
        $defaultImage = $fan['fanimage'];
        
        // 获取产品主图（基于fan_model）
        $fan['product_images'] = $this->getImageUrl($fanModel, $mainImages, $defaultImage);
        $fan['image'] = $this->getImageUrl($fanModel, $mainImages, $defaultImage);
        
        // 获取电路图（基于circuit_image字段值）
        $fan['circuit_image'] = $this->getImageUrl($circuitModel, $circuitImages, $defaultImage);
        
        // 获取外形尺寸图（基于outline_image字段值）
        $fan['outline_image'] = $this->getImageUrl($outlineModel, $outlineImages, $defaultImage);

        try {
            // 根据布局选择不同的PDF生成方法
            if ($layout === 'simple') {
                $pdfFile = ROOT_PATH . 'public/temp/' . '[' . $fan['fan_model'] . ']' . __('Simplified Specification') . '_' . date('YmdHis') . random_int(1000,9999) . '.pdf';
                $pdf = $this->createSimplePdf($fan, [
                    'pq_chart' => $pqChartImage,
                    'power_chart' => $powerChartImage,
                    'efficiency_chart' => $efficiencyChartImage,
                    'product_images' => $fan['product_images'],
                    'circuit_image' => $fan['circuit_image'],
                    'outline_image' => $fan['outline_image']
                ], $contentOptions, $pdfFile);
            } else {
                $pdfFile = ROOT_PATH . 'public/temp/' . '[' . $fan['fan_model'] . ']' . __('Detailed Specification') . '_' . date('YmdHis') . random_int(1000,9999) . '.pdf';
                $pdf = $this->createDetailedPdf($fan, [
                    'pq_chart' => $pqChartImage,
                    'power_chart' => $powerChartImage,
                    'efficiency_chart' => $efficiencyChartImage,
                    'product_images' => $fan['product_images'],
                    'circuit_image' => $fan['circuit_image'],
                    'outline_image' => $fan['outline_image']
                ], $contentOptions, $pdfFile);
            }
            
            // 清理临时文件
            @unlink($pqChartPath);
            @unlink($powerChartPath);
            @unlink($efficiencyChartPath);
            
            // 输出PDF
            $filename = 'Fan_Specification_' . $fan['fan_model'] . '.pdf';
            $filename = basename($pdfFile);
            
            // TCPDF
            // $pdfContent = $pdf->Output('', 'S');
            // // 设置响应头
            // header('Content-Type: application/pdf');
            // header('Content-Disposition: attachment; filename="' . $filename . '"');
            // header('Content-Length: ' . strlen($pdfContent));
            // header('Cache-Control: private, max-age=0, must-revalidate');
            // header('Pragma: public');
            // // 输出PDF内容
            // echo $pdfContent;
            
            //mpdf
            // 下载PDF文件
            header('Content-Type: application/pdf');
            header('Content-Disposition: attachment; filename="' . $filename . '"');
            header('Content-Length: ' . filesize($pdfFile));
            readfile($pdfFile);
            
            // 删除临时PDF文件
            @unlink($pdfFile);
        
            exit;
            
        } catch (Exception $e) {
            $this->error(__('Failed to generate PDF') . ': ' . $e->getMessage());
        }
    }


    /**
     * 生成风机规格HTML
     */
    private function generateHtml($fan, $images, $filename)
    {
        global $filePaths;
        
        $currentLang = Lang::detect();

        // 获取公司logo的URL
        $logoUrl = 'assets/img/seemtek-logo.png'; // 替换为实际的logo路径

        // 构建风机型号描述
        $key = $fan['fan_model'][2] ?? 'E';   // 'E'

        // 映射关系
        $map = [
            'E' => 'EC',
            'D' => 'DC',
            'A' => 'AC'
        ];
        $motor = $map[$key] ?? 'EC';
        $fanTitle = $motor . ' ' . $fan['type_name'];
        $fanDesc = $fanTitle;
        $installMethods = [];
        if ($fan['installation_method']) {
            if (strpos($fan['installation_method'], 'zz') !== false) $installMethods[] = 'Bracket';
            if (strpos($fan['installation_method'], 'cz') !== false) $installMethods[] = 'Side Mount';
            if (strpos($fan['installation_method'], 'dz') !== false) $installMethods[] = 'Hanging';
            
            //if (!empty($installMethods)) {
            //    $fanDesc .= ' With ' . implode('/', $installMethods);
            //}
        }
        //$fanDesc .= ' (Romulus)'; // 可以根据实际情况调整或从数据库获取

        $fanCert = '';
        $fanEnv = '';
        if ($fan['certification']) {
            $certifications = explode(',', $fan['certification']);
            foreach (['CE','UL','CCC'] as $c) {
                if ( in_array($c, $certifications ) ) {
                    $fanCert .= '&nbsp;&nbsp;<span class="chk">&#x2611;</span> ' . $c;
                } else {
                    $fanCert .= '&nbsp;&nbsp;<span class="chk">&#x2610;</span> ' . $c;
                }
            }
            
            foreach (['RoHS','REACH'] as $R) {
                if ( in_array($R, $certifications ) ) {
                    $fanEnv .= '&nbsp;&nbsp;<span class="chk">&#x2611;</span> ' . $R;
                } else {
                    $fanEnv .= '&nbsp;&nbsp;<span class="chk">&#x2610;</span> ' . $R;
                }
            }
        }
        
        $f = ROOT_PATH . 'public/template/' . $filename . '.html';
        $now = new \DateTime();
        $locales = [
            'en' => 'en_US',   // 英文
            'zh-cn' => 'zh_CN',   // 简体中文
            'de' => 'de_DE',   // 德语
            'ru' => 'ru_RU',   // 德语
            'ko' => 'ko_KR',   // 德语
            'es' => 'es_ES',   // 德语
            // …自己按需补
        ];
        $locale = $locales[$currentLang] ?? 'en_US';

        $fmt = new \IntlDateFormatter(
            $locale,
            \IntlDateFormatter::LONG,     // 日期长度
            \IntlDateFormatter::MEDIUM,   // 时间长度
            $now->getTimezone(),
            \IntlDateFormatter::GREGORIAN,
            'MMMM d, yyyy HH:mm:ss'       // 和 format() 类似的自定义模式
        );

        $formattedDate = $fmt->format($now);

        $html = file_get_contents( $filePaths[$filename . '-' . $currentLang] ?? $f);
        $html = str_replace('{DOWNLOAD_DATE}', __("Downloaded on") . ": {$formattedDate}", $html);
        $html = str_replace('{FAN_MODEL}', $fan['fan_model'], $html);
        $html = str_replace('{LOGO}', $logoUrl, $html);
        $html = str_replace('{FAN_IMAGE}', $fan['product_images'], $html);
        $html = str_replace('{TXT_WAIXINGCHICUN}', __('Outline Drawing'), $html);
        
        // ------- 2. 计算缩放后尺寸 -------
        $fullPath = ROOT_PATH . 'public' . $fan['product_images'];
        $newSize = $this->calcScaledSize($fullPath);  // 默认上限 500×450
        
        $html = str_replace('{MAIN_IMAGE_WIDTH}', $newSize['width'], $html);
        $html = str_replace('{MAIN_IMAGE_HEIGHT}', $newSize['height'], $html);
        $html = str_replace('{MAIN_IMAGE_PADDING}', $newSize['height'] < 540 ? 'padding:' . intval((540-$newSize['height'])/2) . 'px 0;' : '', $html);
        
        
        $html = str_replace('{FAN_TITLE}', $fanDesc, $html);
        $html = str_replace('{FAN_TITLE2}', $fanTitle, $html);
        $html = str_replace('{FAN_CERT}', $fanCert, $html);
        $html = str_replace('{FAN_ENV}', $fanEnv, $html);
        $html = str_replace('{FAN_TEMP}',  round($fan['min_operating_temp'] ?? 0,0) . '°C ~ ' . round($fan['max_operating_temp'] ?? 0,0) . '°C', $html);
        $html = str_replace('{FAN_STORE_TEMP}',  $fan['custom_str4'] ?? '/', $html);
        $html = str_replace('{FAN_VOLTAGE}',  round($fan['min_operating_voltage'],0) . ' ~ ' . round($fan['max_operating_voltage'] ?? 0,0) . ' VAC', $html);
        $html = str_replace('{FAN_PROTECT}',  $fan['protection_type'] ?? 'N/A', $html);
        $html = str_replace('{FAN_INSULATION}',  $fan['insulation_class'] ?? 'N/A', $html);
        $html = str_replace('{FAN_MOTORTYPE}',  $fan['motor_type'] ?? 'N/A', $html);
        $html = str_replace('{FAN_MATERIAL}', htmlentities(__($fan['material'])), $html);
        $html = str_replace('{FAN_OPMODE}',  $fan['operation_mode'] ?? 'N/A', $html);
        $html = str_replace('{FAN_NOISE}',  round($fan['sound_level'] ?? 0,0), $html);
        
        $html = str_replace('{FAN_RATEDVOLT}',  '3~' . round($fan['rated_voltage'] ?? 0,0), $html);
        $html = str_replace('{FAN_RATEDSPEED}',  round($fan['rated_speed'] ?? 0,0), $html);
        $html = str_replace('{FAN_RATEDPOWER}',  round($fan['rated_power'] ?? 0,0), $html);
        $html = str_replace('{FAN_RATEDCURRENT}',  ($fan['rated_current'] ?? '0'), $html);
        $html = str_replace('{FAN_SPEEDCTL}',  ($fan['speed_control'] ?? '-'), $html);
        $html = str_replace('{FAN_FREQUENCY}',  ($fan['frequency'] ?? '/'), $html);
        $html = str_replace('{FAN_FREQUENCY_TD}',  ($fan['frequency'] != '' && $fan['frequency'] != '/' ? '<td>' . $fan['frequency'] . 'Hz</td>' : ''), $html);
        $html = str_replace('{FAN_POWERTYPE}',  ($fan['powertype'] ?? '/'), $html);
        
        //$html = str_replace('{FAN_FREQUENCY_TXT}',  $motor == 'DC' ? '' : ('<tr><td>※Frequency: </td><td>' . ($fan['frequency'] ?? '-') .' Hz</td></tr>'), $html);
        if ( !empty($fan['frequency']) && $fan['frequency'] != '/' ) {
            $html = str_replace('{FAN_FREQUENCY_TXT}',  $motor == 'DC' ? '' : ('<tr><td>※' . __('Frequency') . ': </td><td>' . ($fan['frequency'] ?? '-') .' Hz</td></tr>'), $html);
            $html = str_replace('{FAN_FREQUENCY_DIV}', '<div class="item"><p><span class="star-title">※&nbsp;' . __('Frequency') . ': </span>&nbsp; <span class="star-text">' . $fan['frequency'] . ' Hz </span></p></div>', $html);
            
        } else {
            $html = str_replace('{FAN_FREQUENCY_TXT}',  '', $html);
            $html = str_replace('{FAN_FREQUENCY_DIV}',  '', $html);
        }
        $html = str_replace('{FAN_CAPACITY_TXT}',  $motor == 'AC' ? ('<tr><td>※' . __('Capacitor') . ': </td><td>' . ($fan['capacity'] ?? '-') .' μF</td></tr>') : '', $html);
        
        if ( $fan['capacity'] != 0.00 ) {
            $html = str_replace('{FAN_CATACITY_DIV}',  '<div class="item"><p><span class="star-title">※&nbsp;' . __('Capacitor') . ': </span>&nbsp; <span class="star-text">' . $fan['capacity'] . ' μF</span></p></div>', $html);
        } else {
            $html = str_replace('{FAN_CATACITY_DIV}',  '', $html);
        }
        
        $html = str_replace('{SPEED_VSP}', 'assets/img/speedvsp.png', $html);
        $html = str_replace('{SPEED_PWM}', 'assets/img/speedpwm.png', $html);
        //第4页
        $html = str_replace('{IMG_P41}', 'assets/img/p4-1.jpg', $html);
        $html = str_replace('{IMG_P42}', 'assets/img/p4-2.jpg', $html);
        $html = str_replace('{IMG_P43}', 'assets/img/p4-3.jpg', $html);
        $html = str_replace('{IMG_P44}', 'assets/img/p4-4.jpg', $html);
        $html = str_replace('{IMG_P45}', 'assets/img/p4-5.jpg', $html);
        $html = str_replace('{IMG_P46}', 'assets/img/p4-6.jpg', $html);
        

        $html = str_replace('{FAN_CIRCUIT}', $fan['circuit_image'], $html);
        $html = str_replace('{FAN_OUTLINE}', $fan['outline_image'], $html);
        
        $html = str_replace('{FAN_PQCHART}', empty($images['pq_chart']) ? $fan['fanimage'] : $images['pq_chart'], $html);
        $html = str_replace('{FAN_WQCHART}', empty($images['power_chart']) ? $fan['fanimage'] : $images['power_chart'], $html);
        $html = str_replace('{FAN_EQCHART}', empty($images['efficiency_chart']) ? $fan['fanimage'] : $images['efficiency_chart'], $html);
                
        $html = str_replace('{IS_UP}', '&nbsp;&nbsp;<span class="chk">&#x' . (strpos($fan['installation_method'], 'zz') !== false ? '2611' : '2610') . ';</span>' , $html);
        $html = str_replace('{IS_SIDE}', '&nbsp;&nbsp;<span class="chk">&#x' . (strpos($fan['installation_method'], 'cz') !== false ? '2611' : '2610') . ';</span>', $html);
        $html = str_replace('{IS_DOWN}', '&nbsp;&nbsp;<span class="chk">&#x' . (strpos($fan['installation_method'], 'dz') !== false ? '2611' : '2610') . ';</span>', $html);
        
        $html = str_replace('{IS_INLET}', '&nbsp;&nbsp;<span class="chk">&#x2610;</span>', $html);
        $html = str_replace('{IS_BRACKET}', '&nbsp;&nbsp;<span class="chk">&#x2610;</span>', $html);
        $html = str_replace('{IS_CONNECTOR}', '&nbsp;&nbsp;<span class="chk">&#x2610;</span>', $html);
        $html = str_replace('{IS_PITOT}', '&nbsp;&nbsp;<span class="chk">&#x2610;</span>', $html);
        $html = str_replace('{IS_AUARD}', '&nbsp;&nbsp;<span class="chk">&#x2610;</span>', $html);

        $custom_str1 =  explode('/', $fan['custom_str1']);
        $has_mA = !empty(array_filter($custom_str1, function($element) {
            return strpos($element, 'mA') !== false;
        }));
        
        $MADISPLAY  = $has_mA ? 'block;' : 'none;';
        $VSPDISPLAY = in_array('VSP', $custom_str1) ? 'block;' : 'none;';
        $PWMDISPLAY = in_array('PWM', $custom_str1) ? 'block;' : 'none;';

        $html = str_replace('{VSPDISPLAY}', $VSPDISPLAY, $html);
        $html = str_replace('{PWMDISPLAY}', $PWMDISPLAY, $html);
        $html = str_replace('{MADISPLAY}', $MADISPLAY, $html);
        
        $mArr = isset($custom_str1[2]) ? explode('-', $custom_str1[2]) : [];//-
        
        if ( count($mArr) ) {
            $html = str_replace('{MA1}', $mArr[0] . 'mA', $html);
            $html = str_replace('{MA2}', $mArr[1], $html);
        }
        
        if ( !empty($fan['speed_control']) && $fan['speed_control'] != '/' ) {
            $html = str_replace('{HAS_VSP}',  'block', $html);

            $speed_control =  explode('-', (string)$fan['speed_control']);
            $html = str_replace('{VSP1}', $speed_control[0] ?? '', $html);
            $html = str_replace('{VSP2}', $speed_control[1] ?? '', $html);
            $html = str_replace('{MAXVSP}', $speed_control[1] ?? '', $html);

            //$work_humidity =  explode('-', (string)$fan['work_humidity']);
            $PWM1 = 10 * floatval($speed_control[0]);
            $PWM2 = 10 * floatval($speed_control[1]);
            $html = str_replace('{PWM1}', $PWM1, $html);
            $html = str_replace('{PWM2}', $PWM2, $html);
            $html = str_replace('{MAXPWM}', $PWM2, $html);
            
            $html = str_replace('{VSP60}', round(floatval($speed_control[0]) * 0.6, 1), $html);
            $html = str_replace('{PWM60}', round(floatval($speed_control[0]) * 0.6, 1) * 10, $html);
            

        } else {
            $html = str_replace('{HAS_VSP}',  'none', $html);
        }
        
        
        
        $store_humidity =  explode('-', (string)$fan['store_humidity']);
        $html = str_replace('{SHUM1}', $store_humidity[0] ?? '', $html);
        $html = str_replace('{SHUM2}', $store_humidity[1] ?? '', $html);
        $html = str_replace('{STORE_HUMIDITY}', (string)$fan['store_humidity'], $html);
        
        $work_humidity =  explode('-', (string)$fan['work_humidity']);
        $html = str_replace('{WHUM1}', $work_humidity[0] ?? '', $html);
        $html = str_replace('{WHUM2}', $work_humidity[1] ?? '', $html);
        $html = str_replace('{WORK_HUMIDITY}', (string)$fan['work_humidity'], $html);
        
        $html = str_replace('{FAN_CUSTOMSTR1}', $fan['custom_str1'] ?? '', $html);
        $html = str_replace('{FAN_CUSTOMSTR2}', $fan['custom_str2'] ?? '', $html);
        $html = str_replace('{FAN_CUSTOMSTR3}', $fan['custom_str3'] ?? '', $html);
        $html = str_replace('{FAN_WORKHUMIDITY}', $fan['work_humidity'] ?? '-', $html);

        $html = str_replace('{YEAR}', date('y'), $html);
        $html = str_replace('{MONTH}', date('m'), $html);
        
        
        $mstrings = explode('-', $fan['fan_model']);
        $qrTXT = 'S' . $mstrings[0][0] . $mstrings[0][2] . $mstrings[1] . date('my') . str_pad($fan['downloads'], 4, "0", STR_PAD_LEFT);
        $qrCode = new QrCode(
            data: $qrTXT,
            encoding: new Encoding('UTF-8'),
            size: 80,
            margin: 1
        );


        $writer = new PngWriter();
        $result = $writer->write($qrCode);

        // 获取 base64 编码的图片数据
        $base64String = base64_encode($result->getString());

        // 生成完整的 data URI
        $dataUri = 'data:image/png;base64,' . $base64String;
        
        $html = str_replace('{QR_CODE}', $dataUri, $html);
        $html = str_replace('"/uploads/', '"uploads/', $html);

        $host = 'https://' . $_SERVER['HTTP_HOST'];
        $html = preg_replace('#(src=")(?!https?://)([^"]+)#i', '$1'.$host.'/$2', $html);

        return $html;
        
    }   
        
    /**
     * 生成风机 PQ 数据的 HTML（可直接给 mPDF 渲染）
     *
     * @param int $fan   风机产品 
     * @param int $column         每行摆几张子表，默认 2
     * @return string
     */
    public function buildFanPqHtml($fan, $column = 2): string
    {
        global $opvsp, $opdata, $opdata3v, $opdata5v, $opdata8v, $units;
        
        $fanProductId = $fan['id']; 
        //$motor_type = $fan['motor_type'];
        $is_AC = $fan['motor_type'] == 'AC' ? 'true' : 'false';
        $ac_groups = config('site.ac_groups') ?? '';
        if ( !empty($ac_groups) ) {
            $ac_models = explode("\r\n", $ac_groups);
            if ( in_array($fan['fan_model'], $ac_models) ) {
                $is_AC = 'true';
            }
        }
        
        // 1. 取数据（先按 VSP 降序，再按风压升序，保持测试顺序）
        $rows = Db::name('fan_pqdata')
            ->where('fan_product_id', $fanProductId)
            ->where('vsp', '>', 2.8)
            ->orderRaw('CAST(vsp AS DECIMAL(10,2)) DESC, air_pressure ASC')
            ->select();

        if (!$rows) {
            return '';
        }

        // 2. 依 VSP 分组
        $groups = [];
        foreach ($rows as $r) {
            $vsp = number_format((float)$r['vsp'], 2);   // 10.00 / 7.00 …
            $groups[$vsp][] = $r;
        }
        
        //if ( empty($opdata) ) {
            $gvsp = array_keys($groups);
            // 将字符串键转换为浮点数
            $gvsp_float = array_map('floatval', $gvsp);
            
            // AC类型风机的特殊处理逻辑
            if ($is_AC == 'true') {
                $currentVspCount = count($groups);
                
                // 根据当前VSP曲线数量确定目标表格数量
                if ($currentVspCount == 1) {
                    $targetTableCount = 2;  // 1条曲线显示2个表格
                } elseif ($currentVspCount == 2) {
                    $targetTableCount = 2;  // 2条曲线显示2个表格
                } elseif ($currentVspCount == 3) {
                    $targetTableCount = 4;  // 3条曲线显示4个表格
                } elseif ($currentVspCount >= 4) {
                    $targetTableCount = 4;  // 4条及以上曲线显示4个表格
                } else {
                    $targetTableCount = 2;  // 默认显示2个表格
                }
                
                // 添加空表格以达到目标数量
                $emptyTablesNeeded = $targetTableCount - $currentVspCount;
                for ($i = 0; $i < $emptyTablesNeeded; $i++) {
                    // 使用一个不存在的VSP值作为键，确保不与现有数据冲突
                    $emptyKey = 'empty_' . ($i + 1);
                    $groups[$emptyKey] = []; // 空数据数组
                }
            } else {
                // 非AC类型保持原有逻辑
                //array_pop($gvsp_float);
                $gvsp_integers = array_map('intval', $gvsp_float);
                $vsp358 = [5.00,8.00,3.00];
                $diff = array_filter($vsp358, function($value) use ($gvsp_integers) {
                    return !in_array(intval($value), $gvsp_integers);
                });
                //$diff = array_diff($vsp358, $gvsp_float);
                //print_r($diff);exit;
                
                if ( empty($opdata) ) {
                    if ( count($groups) > 2 ) {
                        while ( count($groups) != 2 ) {
                            array_pop($groups);
                        }
                    } else {

                        foreach($diff as $v) {
                            if ( count($groups) == 2 ) {//只显示2个
                                break;
                            }
                            if ( $v == 5 ) {
                                $groups[floatval($v)] = $opdata3v;
                            } else if ( $v == 8 ) {
                                $groups[floatval($v)] = $opdata5v;
                            } else if ( $v == 3 ) {
                                $groups[floatval($v)] = $opdata8v;
                            }
                        }
                    
                    }

                } else {
                    while ( count($groups) != 1 ) {
                        array_pop($groups);
                    }
                    /*
                    foreach($diff as $v) {
                        if ( count($groups) == 2 ) {//只显示2个
                            break;
                        }
                        if ( $v == 3 ) {
                            $groups[floatval($v)] = $opdata3v;
                        } else if ( $v == 5 ) {
                            $groups[floatval($v)] = $opdata5v;
                        } else if ( $v == 8 ) {
                            $groups[floatval($v)] = $opdata8v;
                        }
                    }
                    */
                }
            }
        //}
        //if ( $_SERVER['REMOTE_ADDR'] == '155.117.84.116' ) {
        //    print_r($groups);exit;
        //}

        $converUnits = function ($value, $type) use ($units) {
            $conversionFactors = [
                // 流量单位转换 (基准: m³/h -> 目标单位)
                'flow' => [
                    'm³/h' => 1,
                    'm³/s' => 1/3600,              // 0.000278
                    'l/s' => 1/3.6,                // 0.278
                    'CFM' => 1/1.699011            // 0.588578
                ],
                
                // 压力单位转换 (基准: Pa -> 目标单位)
                'pressure' => [
                    'Pa' => 1,
                    'kPa' => 1/1000,               // 0.001
                    'bar' => 1/100000,             // 0.00001
                    'mbar' => 1/100,               // 0.01
                    'inHG' => 1/3386.39,           // 0.000295299
                    'inwg' => 1/249.089,           // 0.00401463
                    'psi' => 1/6894.76,            // 0.000145038
                    'ftWC' => 1/2989.07,           // 0.00033455
                    'inH₂O' => 0.00401463          // 已经是正确格式，保持不变
                ],
                
                // 功率单位转换 (基准: W -> 目标单位)
                'power' => [
                    'W' => 1,
                    'kW' => 1/1000,                // 0.001
                    'hp' => 1/745.7,               // 0.00134102
                    'BTU/h' => 1/0.293071          // 3.41214
                ],
                
                // 温度单位转换 (从C转换到目标单位)
                'temperature' => [
                    'C' => function($val) { return $val; },
                    'F' => function($val) { return $val * 9/5 + 32; }
                ],
                
                // 温度单位反向转换 (从目标单位转换到C)
                'temperatureReverse' => [
                    'C' => function($val) { return $val; },
                    'F' => function($val) { return ($val - 32) * 5/9; }
                ]
            ];

            // 转换为数据库中的标准单位 m³/h
            if( $type == 'flow' ) {
                if (isset($units['flow']) && isset($conversionFactors['flow'][$units['flow']])) {
                    return $value * $conversionFactors['flow'][$units['flow']];
                }
            }    
            if( $type == 'pressure' ) {
                if (isset($units['pressure']) && isset($conversionFactors['pressure'][$units['pressure']])) {
                    return $value * $conversionFactors['pressure'][$units['pressure']];
                }
            }    
                
            return $value;
        };
        
        $toFixedValue = function ($value, $unit) {
            // 去掉首尾空格，避免传 " Pa "
            $unit = trim($unit);

            // 不同单位对应的小数位
            $decimals = [
                // 3 位
                'm³/s'  => 3, 'm^3/s' => 3, 
                'bar'   => 3,
                'inHG'  => 3,
                'psi'   => 3,
                'inH₂O' => 3, 'inH2O' => 3, 
                'ftWC'  => 3,
                'hp'    => 3,

                // 0 位
                'm³/h'  => 0, 'm^3/h' => 0,
                'CFM'   => 0,
                'Pa'    => 0,
                'W'     => 0,
            ];

            // 查不到就用 2 位
            $keep = $decimals[$unit] ?? 2;

            // number_format 会把 1000 变成 1,000，所以第三个参数设 '.'，第四个设空串
            return number_format((float)$value, $keep, '.', '');
        };
            
        // 3. 子表构造器（单张）
        $subTable = function ($vsp, $list) use ($is_AC, $units, $converUnits, $toFixedValue) {

            $vsplist = config('site.vspdata_ac') ?? '';
            $vspAC = [];
            if ( !empty($vsplist) ) {
                $vspArr = explode("\r\n", $vsplist);
                foreach ($vspArr as $ac) {
                    $_vsp = explode('#', $ac);
                    $vspAC[$_vsp[0]] = $_vsp[1];
                }
                
            }

            // 处理空表格的情况（针对AC类型）
            $isEmptyTable = (strpos($vsp, 'empty_') === 0);
            $displayVsp = ($is_AC == 'true' && isset($vspAC[$vsp])) ? $vspAC[$vsp] : sprintf('%.2f', $vsp);
            
            $speedTD = $is_AC == 'true' ? '' : '<th width="16%" style="color:#ffffff;">' . __('Speed') .'<br/>(rpm)</th>';
            $Efficiency =  __('Efficiency');
            $pressure =  __('Air Pressure');
            $flow =  __('Air Flow');
            $Power =  __('Power');
            $thead = <<<HTML
    <table width="100%" border="1" cellpadding="2" cellspacing="0" style="border-collapse:collapse;">
      <thead>
        <tr style="font-weight:bold;text-align:center;font-size:12px;background-color:black;">
          <th width="18%" style="color:#ffffff;">VSP<br/>(VDC)</th>
          <th width="16%" style="color:#ffffff;">{$Power}<br/>(W)</th>
          {$speedTD}
          <th width="17%" style="color:#ffffff;">{$flow}<br/>({$units['flow']})</th>
          <th width="17%" style="color:#ffffff;">{$pressure}<br/>({$units['pressure']})</th>
          <th width="16%" style="color:#ffffff;">{$Efficiency}<br/>(%)</th>
        </tr>
      </thead>
      <tbody>
HTML;
            
            $tbody = '';
            $vspDone = false;
            $maxRows = 9; // 固定最大行数
            $actualRows = count($list);
            
            // 如果是空表格，直接生成空行
            if ($isEmptyTable || empty($list)) {
                for ($i = 0; $i < $maxRows; $i++) {
                    $tbody .= '<tr style="text-align:right;font-size:9px;">';
                    if (!$vspDone) {
                        $tbody .= '<td rowspan="' . $maxRows . '" style="text-align:center;">' . $displayVsp . '</td>';
                        $vspDone = true;
                    }
                    $tbody .= '<td>&nbsp;</td>'; // Power
                    $tbody .= $is_AC == 'true' ? '' : '<td>&nbsp;</td>'; // Speed  
                    $tbody .= '<td>&nbsp;</td>'; // Air Flow
                    $tbody .= '<td>&nbsp;</td>'; // Air Pressure
                    $tbody .= '<td>&nbsp;</td>'; // Efficiency
                    $tbody .= '</tr>';
                }
            } else {
                // 原有的数据填充逻辑
                // 如果数据超过12行，截取前12行
                $displayList = array_slice($list, 0, $maxRows);
                $displayRows = count($displayList);
                
                // 输出实际数据行
                foreach ($displayList as $row) {
                    $tbody .= '<tr style="text-align:right;font-size:9px;">';
                    if (!$vspDone) {
                        $tbody .= '<td rowspan="' . $maxRows . '" style="text-align:center;">' . $displayVsp . '</td>';
                        $vspDone = true;
                    }
                    
                    $flowRaw = isset($row['air_flow_m3h']) ? $converUnits($row['air_flow_m3h'],'flow') : $converUnits($row['flow'],'flow');
                    $pressRaw = isset($row['air_pressure']) ? $converUnits($row['air_pressure'],'pressure') : $converUnits($row['pressure'],'pressure');
                    $tbody .= '<td>' . $toFixedValue($row['power'], $units['power']) . '</td>';
                    $tbody .=  $is_AC == 'true' ? '' : '<td>' . number_format($row['speed']) . '</td>';
                    $tbody .= '<td>' . $toFixedValue($flowRaw, $units['flow']) . '</td>';
                    $tbody .= '<td>' . $toFixedValue($pressRaw, $units['pressure']) . '</td>';
                    $tbody .= '<td>' . sprintf('%.2f', round($row['efficiency'] ?? 0,2)) . '</td>';
                    $tbody .= '</tr>';
                }
                
                // 如果数据不足12行，填充空行
                for ($i = $displayRows; $i < $maxRows; $i++) {
                    $tbody .= '<tr style="text-align:right;font-size:9px;">';
                    $tbody .= '<td>&nbsp;</td>'; // Power
                    $tbody .= $is_AC == 'true' ? '' : '<td>&nbsp;</td>'; // Speed  
                    $tbody .= '<td>&nbsp;</td>'; // Air Flow
                    $tbody .= '<td>&nbsp;</td>'; // Air Pressure
                    $tbody .= '<td>&nbsp;</td>'; // Efficiency
                    $tbody .= '</tr>';
                }
            }
            
            $tbody .= '</tbody></table>';
            return $thead . $tbody;
        };
            
        $speedTD = $is_AC == 'true' ? '' : '<th width="16%" style="color:#ffffff;">' . __('Speed') .'<br/>(rpm)</th>';

        // 针对AC类型调整列数
        if ($is_AC == 'true') {
            $totalTables = count($groups);
            if ($totalTables == 2) {
                $column = 2; // 2个表格，每行2列
            } elseif ($totalTables == 4) {
                $column = 2; // 4个表格，每行2列，分2行显示
            }
        }

        // 4. 多列排版
        $html   = '';
        $chunks = array_chunk($groups, $column, true);           // [[10V, 8V],[7V,5V] …]
        $missop = true;
        foreach ($chunks as $rowGroup) {
            $html .= '<table width="100%" cellpadding="0" cellspacing="0" autosize="1"><tr>';
            foreach ($rowGroup as $vsp => $list) {
                $html .= '<td width="' . (100 / $column) . '%" valign="top" style="padding:1mm;">';
                $html .= $subTable($vsp, $list);
                $html .= '</td>';
            }
            // 不足列用空单元格补齐，防止 mPDF 排版错位
            $miss = $column - count($rowGroup);
            if ( $miss > 0 ) {
                $html .= '<td colspan="' . $miss . '">';
                if ( !empty($opdata) ) {
                    $opArr = ['OP' => []];
                    foreach ($opdata as $or) {
                        //$ovsp = $or['vps'];
                        //$ovsp = 'OP';
                        $d = [];
                        $d['air_flow_m3h'] = round($or['flow'] ?? 0,2);
                        $d['air_pressure'] = round($or['pressure'] ?? 0,2);
                        $d['power'] = round($or['power'] ?? 0,2);
                        $d['efficiency'] = round($or['efficiency'] ?? 0,2);
                        $d['speed'] = round($or['speed'] ?? 0,2);
                        $opArr['OP'][] = $d;
                    }
                    $html .= $subTable($opvsp, $opArr['OP']);
                    $missop = false;
                }
                $html .= '</td>';
            }
            $html .= '</tr></table>';
        }
        if ( $missop ) {
            $html .= '<table width="100%" cellpadding="0" cellspacing="0" autosize="1"><tr>';
            // 不足列用空单元格补齐，防止 mPDF 排版错位
                $html .= '<td width="50%" valign="top" style="padding:1mm;">';
                if ( !empty($opdata) ) {
                    $opArr = ['OP' => []];
                    foreach ($opdata as $or) {
                        //$ovsp = $or['vps'];
                        //$ovsp = 'OP';
                        $d = [];
                        $d['air_flow_m3h'] = round($or['flow'] ?? 0,2);
                        $d['air_pressure'] = round($or['pressure'] ?? 0,2);
                        $d['power'] = round($or['power'] ?? 0,2);
                        $d['efficiency'] = round($or['efficiency'] ?? 0,2);
                        $d['speed'] = round($or['speed'] ?? 0,2);
                        $opArr['OP'][] = $d;
                    }
                    $html .= $subTable('OP', $opArr['OP']);
                    $missop = false;
                }
            $Efficiency =  __('Efficiency');
            $pressure =  __('Air Pressure');
            $flow =  __('Air Flow');
            $Power =  __('Power');
                $html .= '</td>
                <td width="50%" valign="top" style="padding:1mm;">
                    <table width="100%" border="0" cellpadding="2" cellspacing="0" style="border-collapse:collapse;">        
                    <tr style="font-weight:bold;text-align:center;font-size:12px;background-color:white;">
                      <th width="18%" style="color:#ffffff;">VSP<br/>(VDC)</th>
                      <th width="16%" style="color:#ffffff;">' . $Power . '<br/>(W)</th>
                      ' . $speedTD . '
                      <th width="17%" style="color:#ffffff;">' . $flow . '<br/>(m³/h)</th>
                      <th width="17%" style="color:#ffffff;">' . $pressure . '<br/>(Pa)</th>
                      <th width="16%" style="color:#ffffff;">' . $Efficiency . '<br/>(%)</th>
                    </tr>
                    </table>
                 </td>';
            
            $html .= '</tr></table>';
        }
        

        return $html;
    }

    /**
     * 生成风机 PQ 数据的 HTML（可直接给 mPDF 渲染）
     *
     * @param int $fan   风机产品 
     * @param int $column         每行摆几张子表，默认 2
     * @return string
     */
    public function buildFanPqHtml3($fan, $column = 2): string
    {
        global $opvsp, $opdata, $opdata3v, $opdata5v, $opdata8v, $units;
        
        $fanProductId = $fan['id']; 
        $motor_type = $fan['motor_type'];
        
        // 1. 取数据（先按 VSP 降序，再按风压升序，保持测试顺序）
        $rows = Db::name('fan_pqdata')
            ->where('fan_product_id', $fanProductId)
            ->where('vsp', '>', 3.00)
            ->orderRaw('CAST(vsp AS DECIMAL(10,2)) DESC, air_pressure ASC')
            ->select();

        if (!$rows) {
            return '';
        }

        // 2. 依 VSP 分组
        $groups = [];
        foreach ($rows as $r) {
            $vsp = number_format((float)$r['vsp'], 2);   // 10.00 / 7.00 …
            $groups[$vsp][] = $r;
        }
        //if ( empty($opdata) ) {
            $gvsp = array_keys($groups);
            // 将字符串键转换为浮点数
            $gvsp_float = array_map('floatval', $gvsp);
            $vsp358 = $motor_type == 'AC' ? [10,2] : [10.00,8.00,5.00,3.00];
            $diff = array_diff($vsp358, $gvsp_float);
            //print_r($gvsp);print_r($diff);exit;
            if ( empty($opdata) ) {
                foreach($diff as $v) {
                    if ( count($groups) == 4 ) {
                        break;
                    }
                    if ( $v == 3 ) {
                        $groups[floatval($v)] = $opdata3v;
                    } else if ( $v == 5 ) {
                        $groups[floatval($v)] = $opdata5v;
                    } else if ( $v == 8 ) {
                        $groups[floatval($v)] = $opdata8v;
                    }
                }
            } else {
                foreach($diff as $v) {
                    if ( count($groups) == 3 ) {
                        break;
                    }
                    if ( $v == 3 ) {
                        $groups[floatval($v)] = $opdata3v;
                    } else if ( $v == 5 ) {
                        $groups[floatval($v)] = $opdata5v;
                    } else if ( $v == 8 ) {
                        $groups[floatval($v)] = $opdata8v;
                    }
                }
            }
        //}
        
        $converUnits = function ($value, $type) use ($units) {
			$conversionFactors = [
				// 流量单位转换 (基准: m3/h)
				'flow' => [
					'm³/h' => 1,
					'm³/s' => 3600,
					'l/s' => 3.6,
					'cfm' => 1.699011
				],
				// 压力单位转换 (基准: Pa)
				'pressure' => [
					'Pa' => 1,
					'kPa' => 1000,
					'bar' => 100000,
					'mbar' => 100,
					'inHG' => 3386.39,
					'inwg' => 249.089,
					'psi' => 6894.76,
					'ftWC' => 2989.07,
                    'inH₂O' => 0.00401463,
				],
				// 功率单位转换 (基准: W)
				'power' => [
					'W' => 1,
					'kW' => 1000,
					'hp' => 745.7,
					'BTU/h' => 0.293071
				],
				// 温度单位转换 (特殊处理)
				'temperature' => [
					'C' => function($val) { return $val; },
					'F' => function($val) { return ($val - 32) * 5/9; }
				]
			];
				// 转换为数据库中的标准单位 m³/h
            if( $type == 'flow' ) {
				if (isset($units['flow']) && isset($conversionFactors['flow'][$units['flow']])) {
					return $value * $conversionFactors['flow'][$units['flow']];
				}
            }    
            if( $type == 'pressure' ) {
				if (isset($units['pressure']) && isset($conversionFactors['pressure'][$units['pressure']])) {
					return $value * $conversionFactors['pressure'][$units['pressure']];
				}
            }    
                
            return $value;
        };
        
    $toFixedValue = function ($value, $unit) {
        // 去掉首尾空格，避免传 " Pa "
        $unit = trim($unit);

        // 不同单位对应的小数位
        $decimals = [
            // 3 位
            'm³/s'  => 3, 'm^3/s' => 3, 
            'bar'   => 3,
            'inHG'  => 3,
            'psi'   => 3,
            'inH₂O' => 3, 'inH2O' => 3, 
            'ftWC'  => 3,
            'hp'    => 3,

            // 0 位
            'm³/h'  => 0, 'm^3/h' => 0,
            'CFM'   => 0,
            'Pa'    => 0,
            'W'     => 0,
        ];

        // 查不到就用 2 位
        $keep = $decimals[$unit] ?? 2;

        // number_format 会把 1000 变成 1,000，所以第三个参数设 '.'，第四个设空串
        return number_format((float)$value, $keep, '.', '');
    };
        
        // 3. 子表构造器（单张）
$subTable = function ($vsp, $list) use ($motor_type, $units, $converUnits, $toFixedValue) {
    
    $speedTD = $motor_type == 'AC' ? '' : '<th width="16%" style="color:#ffffff;">Speed<br/>(rpm)</th>';
    $thead = <<<HTML
<table width="100%" border="1" cellpadding="2" cellspacing="0" style="border-collapse:collapse;">
  <thead>
    <tr style="font-weight:bold;text-align:center;font-size:12px;background-color:black;">
      <th width="18%" style="color:#ffffff;">VSP<br/>(VDC)</th>
      <th width="16%" style="color:#ffffff;">Power<br/>(W)</th>
      {$speedTD}
      <th width="17%" style="color:#ffffff;">Air&nbsp;Flow<br/>({$units['flow']})</th>
      <th width="17%" style="color:#ffffff;">Air&nbsp;Pressure<br/>({$units['pressure']})</th>
      <th width="16%" style="color:#ffffff;">Efficiency<br/>(%)</th>
    </tr>
  </thead>
  <tbody>
HTML;
    
    $tbody = '';
    $vspDone = false;
    $maxRows = 12; // 固定最大行数
    $actualRows = count($list);
    
    // 如果数据超过13行，截取前13行
    $displayList = array_slice($list, 0, $maxRows);
    $displayRows = count($displayList);
    
    // 输出实际数据行（最多13行）
    foreach ($displayList as $row) {
        $tbody .= '<tr style="text-align:right;font-size:9px;">';
        if (!$vspDone) {
            // VSP 列纵向合并，跨越所有13行
            $tbody .= '<td rowspan="' . $maxRows . '" style="text-align:center;">' . sprintf('%.2f', $vsp) . '</td>';
            $vspDone = true;
        }
        
        $flowRaw = isset($row['air_flow_m3h']) ? $converUnits($row['air_flow_m3h'],'flow') : $converUnits($row['flow'],'flow');
        $pressRaw = isset($row['air_pressure']) ? $converUnits($row['air_pressure'],'pressure') : $converUnits($row['pressure'],'pressure');
        $tbody .= '<td>' . $toFixedValue($row['power'], $units['power']) . '</td>';
        $tbody .=  $motor_type == 'AC' ? '' : '<td>' . number_format($row['speed']) . '</td>';
        $tbody .= '<td>' . $toFixedValue($flowRaw, $units['flow']) . '</td>';
        $tbody .= '<td>' . $toFixedValue($pressRaw, $units['pressure']) . '</td>';
        $tbody .= '<td>' . sprintf('%.2f', round($row['efficiency'] ?? 0,2)) . '</td>';
        $tbody .= '</tr>';
    }
    
    // 如果数据不足13行，填充空行
    for ($i = $displayRows; $i < $maxRows; $i++) {
        $tbody .= '<tr style="text-align:right;font-size:9px;">';
        // VSP列已经在第一行设置了rowspan，这里不需要再添加
        $tbody .= '<td>&nbsp;</td>'; // Power
        $tbody .= $motor_type == 'AC' ? '' : '<td>&nbsp;</td>'; // Speed  
        $tbody .= '<td>&nbsp;</td>'; // Air Flow
        $tbody .= '<td>&nbsp;</td>'; // Air Pressure
        $tbody .= '<td>&nbsp;</td>'; // Efficiency
        $tbody .= '</tr>';
    }
    
    $tbody .= '</tbody></table>';
    return $thead . $tbody;
};
        
        $speedTD = $motor_type == 'AC' ? '' : '<th width="16%" style="color:#ffffff;">Speed<br/>(rpm)</th>';

        // 4. 多列排版
        $html   = '';
        $chunks = array_chunk($groups, $column, true);           // [[10V, 8V],[7V,5V] …]
        $missop = true;
        foreach ($chunks as $rowGroup) {
            $html .= '<table width="100%" cellpadding="0" cellspacing="0" autosize="1"><tr>';
            foreach ($rowGroup as $vsp => $list) {
                $html .= '<td width="' . (100 / $column) . '%" valign="top" style="padding:1mm;">';
                $html .= $subTable($vsp, $list);
                $html .= '</td>';
            }
            // 不足列用空单元格补齐，防止 mPDF 排版错位
            $miss = $column - count($rowGroup);
            if ( $miss > 0 ) {
                $html .= '<td colspan="' . $miss . '">';
                if ( !empty($opdata) ) {
                    $opArr = ['OP' => []];
                    foreach ($opdata as $or) {
                        //$ovsp = $or['vps'];
                        //$ovsp = 'OP';
                        $d = [];
                        $d['air_flow_m3h'] = round($or['flow'] ?? 0,2);
                        $d['air_pressure'] = round($or['pressure'] ?? 0,2);
                        $d['power'] = round($or['power'] ?? 0,2);
                        $d['efficiency'] = round($or['efficiency'] ?? 0,2);
                        $d['speed'] = round($or['speed'] ?? 0,2);
                        $opArr['OP'][] = $d;
                    }
                    $html .= $subTable($opvsp, $opArr['OP']);
                    $missop = false;
                }
                $html .= '</td>';
            }
            $html .= '</tr></table>';
        }
        if ( $missop ) {
            $html .= '<table width="100%" cellpadding="0" cellspacing="0" autosize="1"><tr>';
            // 不足列用空单元格补齐，防止 mPDF 排版错位
                $html .= '<td width="50%" valign="top" style="padding:1mm;">';
                if ( !empty($opdata) ) {
                    $opArr = ['OP' => []];
                    foreach ($opdata as $or) {
                        //$ovsp = $or['vps'];
                        //$ovsp = 'OP';
                        $d = [];
                        $d['air_flow_m3h'] = round($or['flow'] ?? 0,2);
                        $d['air_pressure'] = round($or['pressure'] ?? 0,2);
                        $d['power'] = round($or['power'] ?? 0,2);
                        $d['efficiency'] = round($or['efficiency'] ?? 0,2);
                        $d['speed'] = round($or['speed'] ?? 0,2);
                        $opArr['OP'][] = $d;
                    }
                    $html .= $subTable('OP', $opArr['OP']);
                    $missop = false;
                }
                $html .= '</td>
                <td width="50%" valign="top" style="padding:1mm;">
                    <table width="100%" border="0" cellpadding="2" cellspacing="0" style="border-collapse:collapse;">        
                    <tr style="font-weight:bold;text-align:center;font-size:12px;background-color:white;">
                      <th width="18%" style="color:#ffffff;">VSP<br/>(VDC)</th>
                      <th width="16%" style="color:#ffffff;">Power<br/>(W)</th>
                      ' . $speedTD . '
                      <th width="17%" style="color:#ffffff;">Air&nbsp;Flow<br/>(m³/h)</th>
                      <th width="17%" style="color:#ffffff;">Air&nbsp;Pressure<br/>(Pa)</th>
                      <th width="16%" style="color:#ffffff;">Efficiency<br/>(%)</th>
                    </tr>
                    </table>
                 </td>';
            
            $html .= '</tr></table>';
        }
        

        return $html;
    }
    
    private function getProductUpdate($id)
    {
        $logs = ProductLog::where('product_id', $id)
            ->order('created_time', 'asc')
            ->group('action')->select();
        
        $i = 0;
        $html = '';
        foreach ($logs as $lg) {
            if ( $i > 2 ) {
                break;
            }
            $html .= '<tr><td>A/' . $i . '</td><td>/</td><td>/</td><td>' . $lg['admin_name'] .'</td><td>' . date('Y/m/d', strtotime($lg['created_time'])) .'</td></tr>';
            $i++;
        }
        $diff = 3 - count($logs);
        if ( $diff > 0 ) {
            for( $i = 0; $i < $diff; $i++) {
                $html .= '<tr><td>A/' . (3-($i+1)) . '</td><td>/</td><td>/</td><td>-</td><td>-</td></tr>';
            }
        }
        return $html;
    }

    /**
     * 创建详细版PDF
     */
    private function createDetailedPdf($fan, $images, $contentOptions, $pdfFile)
    {
        global $density, $units, $opvsp, $opdata, $opdata3v, $opdata5v, $opdata8v, $accessories, $connectortxt;
        global $filePaths;
        
        // 读取规格书模版
        $filePaths = [];// 存放规格书路径
        $currentLang = Lang::detect();
        $pdf_type = 'site.pdf_multipages';
        $pdfArr = config($pdf_type) ?? [];
        if ( $pdfArr ) {
            $ids = $pdfArr[$currentLang];
            $attachment = new Attachment();

            // 将字符串转换为数组
            $idArray = explode(',', $ids);
            // 去除空格并转换为整数
            $idArray = array_map('intval', array_map('trim', $idArray));
            
            if ( count($idArray) ) {
                // 批量查询
                $files = $attachment->whereIn('id', $idArray)->select();

                foreach ($files as $file) {
                    if (!empty($file)) {
                        preg_match('/-([^.]+)\.txt$/', $file['filename'], $m);
                        if ( isset($m[0]) && !empty($m[0]) ) {
                            $fname = str_replace($m[0], '-' . $currentLang, $file['filename']);
                            $filePaths[$fname] = ROOT_PATH . 'public' . $file['url'];
                        } else {
                            $fname = str_replace('.txt', '', $file['filename']);
                            $filePaths[$fname] = ROOT_PATH . 'public' . $file['url'];
                        }

                    }
                }
            }

        }
        
        /*
        if ( $_SERVER['REMOTE_ADDR'] == '188.253.120.136' ) {
        set_error_handler(function($errno, $errstr, $errfile, $errline){
            error_log("[PHP-$errno] $errstr in $errfile:$errline");
            return false; 
        });
        }
        */
        
        $defaultConfig = (new \Mpdf\Config\ConfigVariables())->getDefaults();
        $fontDirs = $defaultConfig['fontDir'];

        $defaultFontConfig = (new \Mpdf\Config\FontVariables())->getDefaults();
        $fontData = $defaultFontConfig['fontdata'];

        $mpdf = new \Mpdf\Mpdf([
            //'tempDir' => ROOT_PATH . 'runtime' . DIRECTORY_SEPARATOR . 'mpdf_tmp', // 确保有写权限
            'fontDir' => array_merge($fontDirs, [
                ROOT_PATH . 'public' . DIRECTORY_SEPARATOR . 'assets' . DIRECTORY_SEPARATOR . 'fonts',
            ]),
            'fontdata' => $fontData + [
                'siyuan' => [               // 在 CSS 或 default_font 里引用
                    'R' => 'SourceHanSansCN-Regular.ttf',
                    'B' => 'SourceHanSansCN-Regular.ttf',
                    'L' => 'SourceHanSansCN-Regular.ttf',
                ],
                'notosanskr' => [
                    'R' => 'NotoSansKR-Regular.ttf',
                    'B' => 'NotoSansKR-Regular.ttf',
                    'L' => 'NotoSansKR-Regular.ttf',
                ],
                'notosans'    => ['R'=>'NotoSans-Regular.ttf','B'=>'NotoSans-Regular.ttf','L'=>'NotoSans-Regular.ttf', ], // 拉丁+西班牙+俄文
            ],
            'default_font' => 'siyuan',     // 默认中文字体
            'autoLangToFont'     => true,
            'autoScriptToLang'   => true,
            'mode' => 'utf-8',
            'format' => 'A4',
            'margin_left' => 10,
            'margin_right' => 10,
            'margin_top' => 10,
            'margin_bottom' => 10,
            
            'memory_limit' => '512M',
            // 禁用一些不必要的功能
            'useSubstitutions' => false,
            'simpleTables' => true,
            'packTableData' => true
        ]);
        
        $mpdf->SetBasePath('https://' . $_SERVER['HTTP_HOST'] . '/');
        $mpdf->curlFollowLocation      = true;
        
        // 设置PDF文档属性
        $mpdf->SetTitle($fan['fan_model'] . ' - Product Specification');
        $mpdf->SetAuthor('Seemtek');
        $mpdf->SetCreator('Seemtek Fan Selection System');
        /*
        if ( $_SERVER['REMOTE_ADDR'] == '188.253.120.136' ) {
        $mpdf->debug            = false;
        $mpdf->showImageErrors  = true;
        $mpdf->allow_output_buffering = true; // 避免报错打断输出
        $mpdf->useSubstitutions = false;      // 保持关闭
        }
        */
        $mpdf->saveHTMLHeader = [];
        $mpdf->saveHTMLFooter = [];

        $seqStr = ['', 'Ⅰ','Ⅱ','Ⅲ','Ⅳ','Ⅴ','Ⅵ','Ⅶ','Ⅷ','Ⅸ', 'Ⅹ'];
        $seq = 1;
        
        $html = $this->generateHtml($fan, $images, 'page1');
        $updateTD = $this->getProductUpdate($fan['id']);
        $html = str_replace('{UPDATE_HTML}', $updateTD, $html);
        // 不报错
        $mpdf->WriteHTML($html);
        
        $mpdf->AddPage();
        $html = $this->generateHtml($fan, $images, 'page2');
        $html = preg_replace('/\{SEQ\}/', $seqStr[$seq++], $html, 1);
        if (in_array('environmental_requirements', $contentOptions)) {
            $html = str_replace('{environmental_requirements}', 'block', $html);
            $html = preg_replace('/\{SEQ\}/', $seqStr[$seq++], $html, 1);
        } else {
            $html = str_replace('{environmental_requirements}', 'none', $html);
        }
        $mpdf->WriteHTML($html);
        
        if ( in_array($fan['motor_type'], ['EC', 'AC', 'DC']) ) {
            $mpdf->AddPage();
            $html = $this->generateHtml($fan, $images, 'page3');
            if (in_array('technical_parameters', $contentOptions)) {
                $html = str_replace('{technical_parameters}', 'block', $html);
                $html = preg_replace('/\{SEQ\}/', $seqStr[$seq++], $html, 1);
            } else {
                $html = str_replace('{technical_parameters}', 'none', $html);
            }

            $mpdf->WriteHTML($html);
        }

        if (in_array('technical_standards', $contentOptions) && in_array($fan['motor_type'], ['EC', 'DC'])) {
            $mpdf->AddPage();
            $html = $this->generateHtml($fan, $images, 'page4');
            $html = preg_replace('/\{SEQ\}/', $seqStr[$seq++], $html, 1);
            $mpdf->WriteHTML($html);
        }
        
        
        if (in_array('circuit_diagram', $contentOptions)) {
            $mpdf->AddPage();
            $html = $this->generateHtml($fan, $images, 'page5');
            $wirebody = (new Wiring)->render($fan['wiring_mode']);
            if ( $wirebody ) {
                $table = '	
                <table class="conn">
                    <colgroup>
                        <col class="w1"><col class="w2"><col class="w3"><col class="w4"><col class="w5">
                    </colgroup>

                    <thead>
                        <tr>
                            <th>' . __('Wire') .'</th>
                            <th>' . __('Signal') .'</th>
                            <th>' . __('Colour') .'</th>
                            <th>' . __('Assignment/Function') .'</th>
                            <th>' . __('Note') .'</th>
                        </tr>
                    </thead>

                    ' . $wirebody . '
                    
                    </table>';
                $html = str_replace('{WIRE_TABLE}', $table, $html);
                $html = str_replace('{WIRE_DISPLAY}', 'block', $html);                
            } else {
                $html = str_replace('{WIRE_TABLE}', '', $html);
                $html = str_replace('{WIRE_DISPLAY}', 'none', $html);         
            }

            $html = preg_replace('/\{SEQ\}/', $seqStr[$seq++], $html, 1);
            $mpdf->WriteHTML($html);
        }
        
        if (in_array('performance_curves', $contentOptions)) {
            $mpdf->AddPage();
            $html = $this->generateHtml($fan, $images, 'page6');
            $html = preg_replace('/\{SEQ\}/', $seqStr[$seq++], $html, 1);
            $html = str_replace('{SET_DENSITY}', $density, $html);
            $pdtable = $this->buildFanPqHtml($fan, 2);
            $html = str_replace('{TABLE_PQDATA}', $pdtable, $html);
            $mpdf->WriteHTML($html);
        }
        
        if (in_array('dimension_drawing', $contentOptions)) {
            $mpdf->AddPage();
            $html = $this->generateHtml($fan, $images, 'page7');
            $html = preg_replace('/\{SEQ\}/', $seqStr[$seq++], $html, 1);
            $mpdf->WriteHTML($html);
        }

        $acclist = config('site.acclist') ?? '';
        $acctxt = '';
        if ( !empty($acclist) ) {
            $acc = explode("\r\n", $acclist);
            foreach ($acc as $a) {
                if ( in_array($a, $accessories ) ) {
                    $acctxt .= '&nbsp;&nbsp;<span class="chk">&#x2611;</span> <span>' . __($a) . '</span>&nbsp;';
                } 
                //else {
                    //$acctxt .= '&nbsp;&nbsp;<span class="chk">&#x2610;</span> <span>' . $a . '</span>&nbsp;';
                //}
                if ( $connectortxt && strtolower($a) == 'connector') {
                    $acctxt .= '&nbsp;&nbsp;<span style="text-decoration: underline;">(&nbsp;&nbsp;&nbsp;' . __($connectortxt) . '&nbsp;&nbsp;&nbsp;)</span>';
                }
            }
            
        }
        if ( $acctxt == '' ) {
            $acctxt = '<p>' . __('This is a standard fan model without additional accessories.') .'</p>';
        }
        
        
        $mpdf->AddPage();
        $html = $this->generateHtml($fan, $images, 'page8');
        $html = preg_replace('/\{SEQ\}/', $seqStr[$seq++], $html, 1);
        $html = str_replace('{ACCESSORYTXT}', $acctxt, $html);
        $mpdf->WriteHTML($html);
        
        if (in_array('testing_standards', $contentOptions)) {
            $mpdf->AddPage();
            $html = $this->generateHtml($fan, $images, 'page9');
            $html = preg_replace('/\{SEQ\}/', $seqStr[$seq++], $html, 1);
            $mpdf->WriteHTML($html);
        }
        
        $mpdf->AddPage();
        $html = $this->generateHtml($fan, $images, 'page10');
        $mpdf->WriteHTML($html);
        
        if ( $this->userAuth->isLogin() ) {
            $user = $this->userAuth->getUser();
            \app\common\model\OperationLog::record('user', $user->id, 'download', '下载详细PDF', '风机型号：' . trim($fan['fan_model']));
            db('fan_product')->where('fan_model', $fan['fan_model'])->setInc('downloads');
        }
        
        // 6. 输出PDF文件并下载
        $mpdf->Output($pdfFile, \Mpdf\Output\Destination::FILE);
    }    

    /**
     * 生成产品规格首页
     * 
     * @param TCPDF $pdf PDF对象
     * @param array $fan 风机数据
     * @param array $images 图片数据
     */
    private function createSimplePdf($fan, $images, $contentOptions, $pdfFile)
    {
        global $filePaths;
        
        // 读取规格书模版
        $filePaths = [];// 存放规格书路径
        $currentLang = Lang::detect();
        $pdf_type = 'site.pdf_singlepage';
        $pdfArr = config($pdf_type) ?? [];
        if ( $pdfArr ) {
            $ids = $pdfArr[$currentLang];
            $attachment = new Attachment();

            // 将字符串转换为数组
            $idArray = explode(',', $ids);
            // 去除空格并转换为整数
            $idArray = array_map('intval', array_map('trim', $idArray));
            
            if ( count($idArray) ) {
                // 批量查询
                $files = $attachment->whereIn('id', $idArray)->select();

                foreach ($files as $file) {
                    if (!empty($file)) {
                        $fname = str_replace('.txt', '', $file['filename']);
                        $filePaths[$fname] = ROOT_PATH . 'public' . $file['url'];
                    }
                }
            }

        }
        
        // 生成HTML内容
        $html = $this->generateHtml($fan, $images, 'single');
        
        //FAN_SINGLEOUTLINE_WH
        // ------- 2. 计算缩放后尺寸 -------
        $fullPath = ROOT_PATH . 'public' . $fan['outline_image'];
        $newSize = $this->calcScaledSize($fullPath, 480, 400);  // 默认上限 500×450
        $html = str_replace('{OUTLINE_IMAGE_WIDTH}', $newSize['width'], $html);
        $html = str_replace('{OUTLINE_IMAGE_HEIGHT}', $newSize['height'], $html);
        $html = str_replace('{OUTLINE_IMAGE_PADDING}', $newSize['height'] < 540 ? 'padding:' . intval((540-$newSize['height'])/2) . 'px 0;' : '', $html);
        
        // 5. 使用mPDF将HTML转换为PDF
        $defaultConfig = (new \Mpdf\Config\ConfigVariables())->getDefaults();
        $fontDirs = $defaultConfig['fontDir'];

        $defaultFontConfig = (new \Mpdf\Config\FontVariables())->getDefaults();
        $fontData = $defaultFontConfig['fontdata'];

        $mpdf = new \Mpdf\Mpdf([
            //'tempDir' => ROOT_PATH . 'runtime' . DIRECTORY_SEPARATOR . 'mpdf_tmp', // 确保有写权限
            'fontDir' => array_merge($fontDirs, [
                ROOT_PATH . 'public' . DIRECTORY_SEPARATOR . 'assets' . DIRECTORY_SEPARATOR . 'fonts',
            ]),
            'fontdata' => $fontData + [
                'siyuan' => [               // 在 CSS 或 default_font 里引用
                    'R' => 'SourceHanSansCN-Regular.ttf',
                    //'B' => 'SourceHanSansCN-Bold.ttf',
                    // 'L' => 'SourceHanSansCN-Light.ttf',
                ],
                'notosanskr' => [
                    'R' => 'NotoSansKR-Regular.ttf',
                    //'B' => 'NotoSansKR-Bold.otf',
                ],
                'notosans'    => ['R'=>'NotoSans-Regular.ttf', ], // 拉丁+西班牙+俄文
            ],
            'default_font' => 'siyuan',     // 默认中文字体
            'autoLangToFont'     => true,
            'autoScriptToLang'   => true,
            'mode' => 'utf-8',
            'format' => 'A4',
            'margin_left' => 10,
            'margin_right' => 10,
            'margin_top' => 10,
            'margin_bottom' => 10,
        ]);
        $mpdf->SetBasePath('https://' . $_SERVER['HTTP_HOST'] . '/');
        $mpdf->curlFollowLocation      = true;
        //$mpdf->showImageErrors = true;   // 打开图片错误输出
        //$mpdf->debug           = true;   // 更多 debug
        
        // 设置PDF文档属性
        $mpdf->SetTitle($fan['fan_model'] . ' - Product Specification');
        $mpdf->SetAuthor('Seemtek');
        $mpdf->SetCreator('Seemtek Fan Selection System');
        
        // 添加HTML内容到PDF
        $mpdf->WriteHTML($html);

        if ( $this->userAuth->isLogin() ) {
            $user = $this->userAuth->getUser();
            \app\common\model\OperationLog::record('user', $user->id, 'download', '下载简易PDF', '风机型号：' . trim($fan['fan_model']));
        }
        
        // 6. 输出PDF文件并下载
        $mpdf->Output($pdfFile, \Mpdf\Output\Destination::FILE);
        
    }
    
public function exportPQ()
{
    if (!$this->auth->check('fan/downloadpq')) {
        $this->error(__('You have no permission'));
    }
    if (!$this->request->isPost()) $this->error(__('Invalid request'));

    $fanId = $this->request->post('id/d');
    $op    = json_decode(htmlspecialchars_decode($this->request->post('operating_point')), true);
    $opPQ    = json_decode(htmlspecialchars_decode($this->request->post('newpqdata')), true);
    
    if (!$fanId || !$op) $this->error(__('Missing parameters'));

    // ① 取风机信息
    $fan = Db::name('fan_product')->find($fanId);
    if (!$fan) $this->error(__('No results were found'));

    // ② 取 PQ 数据，按 vsp→flow 排序
    $pqRows = Db::name('fan_pqdata')
        ->where('fan_product_id', $fanId)
        ->order('vsp desc, air_flow_m3h asc')
        ->select();

    // ③ 载入模板
    $tpl = ROOT_PATH . 'public/template/fan_pq_export_template.xlsx';
    $aid = config('site.template_pq_download') ?? 0;
    $attachment = new Attachment();
    $file = $attachment->get($aid);
    if (!empty($file)) {
        $tpl = ROOT_PATH . 'public' . $file['url'];
    }
    
    $spreadsheet = \PhpOffice\PhpSpreadsheet\IOFactory::load($tpl);
    $sheet       = $spreadsheet->getActiveSheet();

    /* ======= 头部信息写入 ======= */
    $sheet->setCellValue('Q3', $fan['fan_model']);          // Fan Type
    $sheet->setCellValue('C3', $op['temperature']);         // Air Temperature
    $sheet->setCellValue('S3', $op['density']);             // Air Density

    /* ======= 写 PQ 曲线 ======= */
    // ====== 配置 ======
    $baseRow     = 6;   // 第一行
    $blockHeight = 16;  // 15 行数据 + 1 行空白
    $startCol    = 16;  // P 列对应的列索引 (从1开始)

    // 1. 取出并排序 vsp
    $vspValues = array_unique(array_column($pqRows, 'vsp'), SORT_NUMERIC);
    rsort($vspValues, SORT_NUMERIC);         // 例如 [10, 1.5]

    // 2. 把 vsp 映射到区块下标
    $slotForVsp = [];
    switch (count($vspValues)) {
        case 3:                                // 全部都有
            foreach ($vspValues as $idx => $v) {
                $slotForVsp[$v] = $idx;        // 0 → 最大，1 → 次大，2 → 最小
            }
            break;
        case 2:                                // 最大放最上，最小放最下
            $slotForVsp[$vspValues[0]] = 0;    // block 0
            $slotForVsp[$vspValues[1]] = 2;    // block 2
            break;
        case 1:                                // 只有一个
        default:
            $slotForVsp[$vspValues[0]] = 0;
    }

    // 3. 按 vsp 把行分组
    $groupedRows = [];
    foreach ($pqRows as $r) {
        $groupedRows[$r['vsp']][] = $r;
    }

    // 4. 逐组写入 - 使用新的方法
    foreach ($slotForVsp as $vsp => $blockIdx) {
        $rowStart = $baseRow + $blockIdx * $blockHeight; // 6 / 22 / 38
        $i = 0;                                          // 当前组内行号 (0-14)

        foreach ($groupedRows[$vsp] as $r) {
            if ($i >= 15) break;                        // 最多 15 行

            $currentRow = $rowStart + $i;               // 计算实际 Excel 行号

            // 使用新的方法设置单元格值
            $sheet->setCellValue($this->getColumnLetter($startCol) . $currentRow, $r['power']);
            $sheet->setCellValue($this->getColumnLetter($startCol + 1) . $currentRow, $r['current']);
            $sheet->setCellValue($this->getColumnLetter($startCol + 2) . $currentRow, $r['speed']);
            $sheet->setCellValue($this->getColumnLetter($startCol + 3) . $currentRow, $r['air_flow_m3h']);
            $sheet->setCellValue($this->getColumnLetter($startCol + 4) . $currentRow, $r['air_pressure_amend']);
            $sheet->setCellValue($this->getColumnLetter($startCol + 5) . $currentRow, $r['noise']);

            ++$i;
        }
    }

    /* ======= 追加操作点 ======= */
    $row = 54;   // 空 1 行更直观
    foreach ($opPQ as $_op) {
        $sheet->setCellValue($this->getColumnLetter($startCol) . $row, ceil($_op['power']));
        $sheet->setCellValue($this->getColumnLetter($startCol + 1) . $row, 0.0);
        $sheet->setCellValue($this->getColumnLetter($startCol + 2) . $row, ceil($_op['speed']));
        $sheet->setCellValue($this->getColumnLetter($startCol + 3) . $row, ceil($_op['flow']));
        $sheet->setCellValue($this->getColumnLetter($startCol + 4) . $row, ceil($_op['pressure']));
        $sheet->setCellValue($this->getColumnLetter($startCol + 5) . $row, 0.0);
        $row++;
    }
    
    if ($this->userAuth->isLogin()) {
        $user = $this->userAuth->getUser();
        \app\common\model\OperationLog::record('user', $user->id, 'download', '下载风机PQ数据', '风机型号：' . trim($fan['fan_model']));
    }
    
    /* ======= 输出下载 ======= */
    $fileName = $fan['fan_model'] . '_PQ_' . date('Ymd_His') . '.xlsx';
    header('Content-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    header('Content-Disposition: attachment; filename="' . $fileName . '"');
    header('Cache-Control: max-age=0');
    \PhpOffice\PhpSpreadsheet\IOFactory::createWriter($spreadsheet, 'Xlsx')->save('php://output');
    exit;
}

/**
 * 将列索引转换为Excel列字母
 * @param int $columnIndex 列索引 (从1开始)
 * @return string 列字母 (如 A, B, ..., Z, AA, AB, ...)
 */
private function getColumnLetter($columnIndex)
{
    return \PhpOffice\PhpSpreadsheet\Cell\Coordinate::stringFromColumnIndex($columnIndex);
}
        
    public function exportPQ23()
    {
        if (!$this->auth->check('fan/downloadpq')) {
            $this->error(__('You have no permission'));
        }
        if (!$this->request->isPost()) $this->error(__('Invalid request'));

        $fanId = $this->request->post('id/d');
        $op    = json_decode(htmlspecialchars_decode($this->request->post('operating_point')), true);
        $opPQ    = json_decode(htmlspecialchars_decode($this->request->post('newpqdata')), true);
        
        //var_dump($fanId);var_dump($op);exit;

        if (!$fanId || !$op) $this->error(__('Missing parameters'));

        // ① 取风机信息
        $fan = Db::name('fan_product')->find($fanId);
        if (!$fan) $this->error(__('No results were found'));

        // ② 取 PQ 数据，按 vsp→flow 排序
        $pqRows = Db::name('fan_pqdata')
            ->where('fan_product_id', $fanId)
            ->order('vsp desc, air_flow_m3h asc')
            ->select();
            //print_r($pqRows);exit;

        // ③ 载入模板
        $tpl = ROOT_PATH . 'public/template/fan_pq_export_template.xlsx';
		$aid = config('site.template_pq_download') ?? 0;
        $attachment = new Attachment();
        $file = $attachment->get($aid);
        if ( !empty($file) ) {
            $tpl = ROOT_PATH . 'public' . $file['url'];
        }
        $spreadsheet = \PhpOffice\PhpSpreadsheet\IOFactory::load($tpl);
        $sheet       = $spreadsheet->getActiveSheet();

        /* ======= 头部信息写入 (行列均 1-based) ======= */
        $sheet->setCellValue('Q3', $fan['fan_model']);          // Fan Type
        $sheet->setCellValue('C3', $op['temperature']);         // Air Temperature
        $sheet->setCellValue('S3', $op['density']);             // Air Density

        /* ======= 写 PQ 曲线 ======= 
        $row = 6;             // Excel 的第 6 行
        $col = 16;            // 第 16 列即 P 列
        $vsp = -1;
        $i = 1;
        foreach ($pqRows as $r) {
            if ( $i > 15 && $vsp == $r['vsp']) {
                continue;
            }
            if ( $vsp != $r['vsp']) {
                if ($vsp != -1) {
                    $row = $row + (17 - $i);//最多15行一个数据
                    $i = 1;
                };
                $vsp = $r['vsp'];
            }
            
            $sheet->setCellValueByColumnAndRow($col    , $row, $r['power']);
            $sheet->setCellValueByColumnAndRow($col + 1, $row, $r['current']);
            $sheet->setCellValueByColumnAndRow($col + 2, $row, $r['speed']);
            $sheet->setCellValueByColumnAndRow($col + 3, $row, $r['air_flow_m3h']);
            $sheet->setCellValueByColumnAndRow($col + 4, $row, $r['air_pressure_amend']);
            $sheet->setCellValueByColumnAndRow($col + 5, $row, $r['noise']);
            $row++;
            $i++;
            
        }
        */
        // ====== 配置 ======
        $baseRow     = 6;   // 第一行
        $blockHeight = 16;  // 15 行数据 + 1 行空白
        $col         = 16;  // P 列

        // 1. 取出并排序 vsp
        $vspValues = array_unique(array_column($pqRows, 'vsp'), SORT_NUMERIC);
        rsort($vspValues, SORT_NUMERIC);         // 例如 [10, 1.5]

        // 2. 把 vsp 映射到区块下标
        $slotForVsp = [];
        switch (count($vspValues)) {
            case 3:                                // 全部都有
                foreach ($vspValues as $idx => $v) {
                    $slotForVsp[$v] = $idx;        // 0 → 最大，1 → 次大，2 → 最小
                }
                break;
            case 2:                                // 最大放最上，最小放最下
                $slotForVsp[$vspValues[0]] = 0;    // block 0
                $slotForVsp[$vspValues[1]] = 2;    // block 2
                break;
            case 1:                                // 只有一个
            default:
                $slotForVsp[$vspValues[0]] = 0;
        }

        // 3. 按 vsp 把行分组
        $groupedRows = [];
        foreach ($pqRows as $r) {
            $groupedRows[$r['vsp']][] = $r;
        }

        // 4. 逐组写入
        foreach ($slotForVsp as $vsp => $blockIdx) {

            $rowStart = $baseRow + $blockIdx * $blockHeight; // 6 / 22 / 38
            $i = 0;                                          // 当前组内行号 (0-14)

            foreach ($groupedRows[$vsp] as $r) {
                if ($i >= 15) break;                        // 最多 15 行

                $row = $rowStart + $i;                      // 计算实际 Excel 行号

                $sheet->setCellValueByColumnAndRow($col    , $row, $r['power']);
                $sheet->setCellValueByColumnAndRow($col + 1, $row, $r['current']);
                $sheet->setCellValueByColumnAndRow($col + 2, $row, $r['speed']);
                $sheet->setCellValueByColumnAndRow($col + 3, $row, $r['air_flow_m3h']);
                $sheet->setCellValueByColumnAndRow($col + 4, $row, $r['air_pressure_amend']);
                $sheet->setCellValueByColumnAndRow($col + 5, $row, $r['noise']);

                ++$i;
            }
        }

        /* ======= 追加操作点 ======= */
        $row = 54;   // 空 1 行更直观
        foreach ($opPQ as $_op) {
            $sheet->setCellValueByColumnAndRow($col    , $row, ceil($_op['power']));
            $sheet->setCellValueByColumnAndRow($col + 1, $row, 0.0);
            $sheet->setCellValueByColumnAndRow($col + 2, $row, ceil($_op['speed']));
            $sheet->setCellValueByColumnAndRow($col + 3, $row, ceil($_op['flow']));
            $sheet->setCellValueByColumnAndRow($col + 4, $row, ceil($_op['pressure']));
            $sheet->setCellValueByColumnAndRow($col + 5, $row, 0.0);
            $row++;
        }
        
        if ( $this->userAuth->isLogin() ) {
            $user = $this->userAuth->getUser();
            \app\common\model\OperationLog::record('user', $user->id, 'download', '下载风机PQ数据', '风机型号：' . trim($fan['fan_model']));
        }
        
        
        /* ======= 输出下载 ======= */
        $fileName = $fan['fan_model'] . '_PQ_' . date('Ymd_His') . '.xlsx';
        header('Content-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        header('Content-Disposition: attachment; filename="' . $fileName . '"');
        header('Cache-Control: max-age=0');
        \PhpOffice\PhpSpreadsheet\IOFactory::createWriter($spreadsheet, 'Xlsx')->save('php://output');
        exit;
    }

    /**
     * 导出PQ数据到Excel
     */
    public function exportPQData2()
    {
        $fanId = $this->request->post('fan_id/d', 0);
        $operatingPoint = $this->request->post('operating_point', '');
        $temperature = $this->request->post('temperature', 20);
        $density = $this->request->post('density', 1.204);
        
        if (!$fanId) {
            $this->error(__('Fan ID not provided'));
        }
        
        // 获取风机信息
        $fan = $this->model->find($fanId);
        if (!$fan) {
            $this->error(__('Fan not found'));
        }
        
        // 解析操作点数据
        $operatingPointData = json_decode($operatingPoint, true);
        if (!$operatingPointData) {
            $this->error(__('Operating point data not provided'));
        }
        
        try {
            // 读取模板文件
            $templatePath = ROOT_PATH . 'public/template/fan_pq_export_template.xlsx';
            if (!file_exists($templatePath)) {
                $this->error(__('Template file not found'));
            }
            
            $spreadsheet = \PhpOffice\PhpSpreadsheet\IOFactory::load($templatePath);
            $worksheet = $spreadsheet->getActiveSheet();
            
            // 填充基本信息
            $worksheet->setCellValue('A2', $fan['fan_model']); // Fan Type
            $worksheet->setCellValue('C3', $temperature); // Air Temperature
            $worksheet->setCellValue('J3', $density); // Air Density
            $worksheet->setCellValue('H2', date('Y-m-d')); // Test Date
            
            // 获取PQ数据，按VSP排序
            $pqData = Db::name('fan_pqdata')
                ->where('fan_product_id', $fanId)
                ->order('vsp ASC, air_flow_m3h ASC')
                ->select();
            
            if (empty($pqData)) {
                $this->error(__('No PQ data found'));
            }
            
            // 按VSP分组
            $groupedData = [];
            foreach ($pqData as $data) {
                $vsp = $data['vsp'];
                if (!isset($groupedData[$vsp])) {
                    $groupedData[$vsp] = [];
                }
                $groupedData[$vsp][] = $data;
            }
            
            // 从第6行开始填充数据（索引从0开始是第5行）
            $startRow = 5;
            $currentRow = $startRow;
            
            // 填充每个VSP的数据
            foreach ($groupedData as $vsp => $vspData) {
                // VSP标题行
                $worksheet->setCellValue('A' . ($currentRow + 1), 'VSP: ' . $vsp . 'V');
                $currentRow += 2; // 跳过标题行
                
                $dataIndex = 1;
                foreach ($vspData as $data) {
                    // 列索引从P开始（第16列，索引15）
                    $worksheet->setCellValue('A' . $currentRow, $dataIndex); // No.
                    $worksheet->setCellValue('B' . $currentRow, $vsp); // VSP
                    $worksheet->setCellValue('C' . $currentRow, $data['power']); // Power
                    $worksheet->setCellValue('D' . $currentRow, $data['current']); // Current
                    $worksheet->setCellValue('E' . $currentRow, $data['speed']); // Speed
                    $worksheet->setCellValue('G' . $currentRow, $data['air_flow_m3h']); // Air Flow m³/h
                    $worksheet->setCellValue('H' . $currentRow, $data['air_flow_cfm']); // Air Flow CFM
                    $worksheet->setCellValue('J' . $currentRow, $data['air_pressure']); // Air Pressure
                    $worksheet->setCellValue('L' . $currentRow, $data['efficiency']); // Efficiency
                    $worksheet->setCellValue('M' . $currentRow, $data['noise']); // Noise
                    
                    $currentRow++;
                    $dataIndex++;
                }
                
                $currentRow += 2; // VSP组之间的间隔
            }
            
            // 添加操作点数据
            if (!empty($operatingPointData)) {
                $currentRow += 2;
                $worksheet->setCellValue('A' . $currentRow, __('Operating Point Data'));
                $currentRow += 2;
                
                // 操作点数据标题
                $worksheet->setCellValue('A' . $currentRow, 'No.');
                $worksheet->setCellValue('B' . $currentRow, 'VSP');
                $worksheet->setCellValue('C' . $currentRow, __('Power') . ' (W)');
                $worksheet->setCellValue('D' . $currentRow, __('Current') . ' (A)');
                $worksheet->setCellValue('E' . $currentRow, __('Speed') . ' (rpm)');
                $worksheet->setCellValue('G' . $currentRow, __('Air Flow') . ' (m³/h)');
                $worksheet->setCellValue('J' . $currentRow, __('Air Pressure') . ' (Pa)');
                $worksheet->setCellValue('L' . $currentRow, __('Efficiency') . ' (%)');
                $worksheet->setCellValue('M' . $currentRow, __('Noise') . ' (dBA)');
                $currentRow++;
                
                // 填充操作点数据
                $worksheet->setCellValue('A' . $currentRow, 'OP');
                $worksheet->setCellValue('C' . $currentRow, $operatingPointData['power'] ?? '');
                $worksheet->setCellValue('D' . $currentRow, $operatingPointData['current'] ?? '');
                $worksheet->setCellValue('E' . $currentRow, $operatingPointData['speed'] ?? '');
                $worksheet->setCellValue('G' . $currentRow, $operatingPointData['flow'] ?? '');
                $worksheet->setCellValue('J' . $currentRow, $operatingPointData['pressure'] ?? '');
                $worksheet->setCellValue('L' . $currentRow, $operatingPointData['efficiency'] ?? '');
                $worksheet->setCellValue('M' . $currentRow, $operatingPointData['noise'] ?? '');
            }
            
            // 生成文件名
            $filename = 'PQ_Data_' . $fan['fan_model'] . '_' . date('Y-m-d_H-i-s') . '.xlsx';
            
            // 设置响应头
            header('Content-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
            header('Content-Disposition: attachment; filename="' . $filename . '"');
            header('Cache-Control: max-age=0');
            
            // 输出文件
            $writer = \PhpOffice\PhpSpreadsheet\IOFactory::createWriter($spreadsheet, 'Xlsx');
            $writer->save('php://output');
            
            exit;
            
        } catch (Exception $e) {
            $this->error(__('Export failed') . ': ' . $e->getMessage());
        }
    }


    /**
     * AJAX 搜索型号
     * /admin/fan/search_model?q=xxx
     */
    public function search_model(Request $request)
    {
        $kw = $request->get('q/s', '');
        $list = Db::name('fan_product')
            ->field('id,fan_model')
            ->where('fan_model', 'like', "%{$kw}%")
			->where('status', '1')
            ->order('fan_model')
            ->limit(10)
            ->select();
        return json($list);
    }
	
	/**
	 * 获取默认风机的 PQ 数据
	 */
	public function getDefaultPQData()
	{
		// 查询所有风机的 ID
		$fanIds = Db::name('fan_pqdata')
			->distinct(true)
			->column('fan_product_id');
		
		if (empty($fanIds)) {
			$this->error('未找到 PQ 数据');
			return;
		}
		
		$pqData = [];
		
		// 对每个风机，查询其最大 VSP 的数据
		foreach ($fanIds as $fanId) {
			// 查询该风机的最大 VSP
			$maxVsp = Db::name('fan_pqdata')
				->where('fan_product_id', $fanId)
				->max('vsp');
			
			if ($maxVsp) {
				// 获取该风机在最大 VSP 下的所有数据
				$fanPqData = Db::name('fan_pqdata')
					->where('fan_product_id', $fanId)
					->where('vsp', $maxVsp)
					->select();
				
				// 合并到结果中
				$pqData = array_merge($pqData, $fanPqData);
			}
		}
		
		if (!empty($pqData)) {
			$this->success('', null, $pqData);
		} else {
			$this->error('未找到 PQ 数据');
		}
	}

	/**
	 * 获取指定风机的 PQ 数据
	 */
	public function getPQDataByID()
	{
		$fanId = $this->request->get('fan_id/d', 0);
		
		if (!$fanId) {
			$this->error('参数错误');
		}
		
		// 获取该风机的所有 PQ 数据
		$pqData = Db::name('fan_pqdata')
			->where('fan_product_id', $fanId)
			->select();
		
		if ($pqData) {
			$this->success('', null, $pqData);
		} else {
			$this->error('未找到 PQ 数据');
		}
	}

	/**
	 * 获取多个风机的 PQ 数据
	 */
	public function getMultipleFansPQData()
	{
		$fanIds = $this->request->post('fan_ids');
		
		if (empty($fanIds)) {
			$this->error(__('Parameter error'));
		}
		
		// 将逗号分隔的 ID 转换为数组
		$fanIdArray = explode(',', $fanIds);
		
		// 获取这些风机的 PQ 数据
		$pqData = Db::name('fan_pqdata')
			->whereIn('fan_product_id', $fanIdArray)
			->order('id', 'asc')
			->select();

		if ($pqData) {
			$this->success('', null, $pqData);
		} else {
			$this->error(__('No PQ data found'));
		}
	}


    /**
     * 为风机找到合适的VSP曲线（排除最小VSP，选择有数据点满足条件的VSP）
     * @param float $minAirFlow
     * @param float $maxAirFlow  
     * @param float $minAirPressure
     * @param float $maxAirPressure
     * @return array [fan_product_id => suitable_vsp]
     */
    private function findSuitableVspForFans($minAirFlow, $maxAirFlow, $minAirPressure, $maxAirPressure)
    {
      // 第一步：获取所有可能的风机产品ID
      $candidateQuery = Db::name('fan_pqdata');
      
      // 添加风量条件
      if ($minAirFlow && $maxAirFlow) {
          $candidateQuery->where('air_flow_m3h', 'between', [$minAirFlow, $maxAirFlow]);
      } elseif ($minAirFlow) {
          $candidateQuery->where('air_flow_m3h', '>=', $minAirFlow);
      } elseif ($maxAirFlow) {
          $candidateQuery->where('air_flow_m3h', '<=', $maxAirFlow);
      }
      
      // 添加静压条件
      if ($minAirPressure && $maxAirPressure) {
          $candidateQuery->where('air_pressure', 'between', [$minAirPressure, $maxAirPressure]);
      } elseif ($minAirPressure) {
          $candidateQuery->where('air_pressure', '>=', $minAirPressure);
      } elseif ($maxAirPressure) {
          $candidateQuery->where('air_pressure', '<=', $maxAirPressure);
      }
      
      $candidateFans = $candidateQuery->group('fan_product_id')->column('fan_product_id');
      
      if (empty($candidateFans)) {
          return [];
      }
      
      // 第二步：为每个风机找到合适的VSP
      $suitableVspMap = [];
      
      foreach ($candidateFans as $fanId) {
          $suitableVsp = $this->selectOptimalVsp($fanId, $minAirFlow, $maxAirFlow, $minAirPressure, $maxAirPressure);
          if ($suitableVsp !== null) {
              $suitableVspMap[$fanId] = $suitableVsp;
          }
      }
      
      return $suitableVspMap;
    }

    /**
     * 为单个风机选择最优VSP
     * @param int $fanId
     * @param float $minAirFlow
     * @param float $maxAirFlow
     * @param float $minAirPressure  
     * @param float $maxAirPressure
     * @return float|null
     */
    private function selectOptimalVsp($fanId, $minAirFlow, $maxAirFlow, $minAirPressure, $maxAirPressure)
    {
      // 获取该风机所有VSP值，按降序排列
      $allVsps = Db::name('fan_pqdata')
          ->where('fan_product_id', $fanId)
          ->group('vsp')
          ->order('vsp desc')
          ->column('vsp');
      
      if (empty($allVsps)) {
          return null;
      }
      
      // 如果只有一个VSP，直接返回
      if (count($allVsps) == 1) {
          return $allVsps[0];
      }
      
      // 排除最小的VSP值
      $minVsp = min($allVsps);
      $availableVsps = array_filter($allVsps, function($vsp) use ($minVsp) {
          return $vsp > $minVsp;
      });
      
      // 如果排除最小VSP后没有可用VSP，返回次小的VSP
      if (empty($availableVsps)) {
          rsort($allVsps);
          return count($allVsps) > 1 ? $allVsps[1] : $allVsps[0];
      }
      
      // 从高到低检查每个VSP，找到第一个有满足条件数据点的VSP
      foreach ($availableVsps as $vsp) {
          if ($this->vspHasMatchingData($fanId, $vsp, $minAirFlow, $maxAirFlow, $minAirPressure, $maxAirPressure)) {
              return $vsp;
          }
      }
      
      // 如果没有VSP有满足条件的数据点，返回最大的可用VSP
      return max($availableVsps);
    }

    /**
     * 检查指定VSP是否有满足条件的数据点
     * @param int $fanId
     * @param float $vsp
     * @param float $minAirFlow
     * @param float $maxAirFlow
     * @param float $minAirPressure
     * @param float $maxAirPressure  
     * @return bool
     */
    private function vspHasMatchingData($fanId, $vsp, $minAirFlow, $maxAirFlow, $minAirPressure, $maxAirPressure)
    {
      $query = Db::name('fan_pqdata')
          ->where('fan_product_id', $fanId)
          ->where('vsp', $vsp);
      
      // 添加风量条件
      if ($minAirFlow && $maxAirFlow) {
          $query->where('air_flow_m3h', 'between', [$minAirFlow, $maxAirFlow]);
      } elseif ($minAirFlow) {
          $query->where('air_flow_m3h', '>=', $minAirFlow);
      } elseif ($maxAirFlow) {
          $query->where('air_flow_m3h', '<=', $maxAirFlow);
      }
      
      // 添加静压条件
      if ($minAirPressure && $maxAirPressure) {
          $query->where('air_pressure', 'between', [$minAirPressure, $maxAirPressure]);
      } elseif ($minAirPressure) {
          $query->where('air_pressure', '>=', $minAirPressure);
      } elseif ($maxAirPressure) {
          $query->where('air_pressure', '<=', $maxAirPressure);
      }
      
      return $query->count() > 0;
    }

    // 风机搜索方法
	public function search()
	{
		if ($this->request->isAjax()) {
			$params = $this->request->post();
			
			// 解析单位设置
            $units = [];
			$units['flow'] = $params['flowunit'] ?? 'm³/h';
			$units['pressure'] = $params['pressunit'] ?? 'Pa';
			$units['power'] = $params['powerunit'] ?? 'W';

			
			// 单位转换系数 - 与前端 settings.js 中的 conversionFactors 保持一致
			$conversionFactors = [
				// 流量单位转换 (基准: m3/h)
				'flow' => [
					'm³/h' => 1,
					'm³/s' => 3600,
					'l/s' => 3.6,
					'cfm' => 1.699011
				],
				// 压力单位转换 (基准: Pa)
				'pressure' => [
					'Pa' => 1,
					'kPa' => 1000,
					'bar' => 100000,
					'mbar' => 100,
					'inHG' => 3386.39,
					'inwg' => 249.089,
					'psi' => 6894.76,
					'ftWC' => 2989.07
				],
				// 功率单位转换 (基准: W)
				'power' => [
					'W' => 1,
					'kW' => 1000,
					'hp' => 745.7,
					'BTU/h' => 0.293071
				],
				// 温度单位转换 (特殊处理)
				'temperature' => [
					'C' => function($val) { return $val; },
					'F' => function($val) { return ($val - 32) * 5/9; }
				]
			];
			
			// 获取筛选条件
			$tolerance_min = $params['tolerance_min'] ?? -30;
			$tolerance_max = $params['tolerance_max'] ?? 30;
			
			// 风机类型筛选
			$typeIds = [];
			if (isset($params['fan_type_ids']) && $params['fan_type_ids']) {
				$typeIds = explode(',', $params['fan_type_ids']);
			}

			// 风量和静压筛选   暂时不用     
			if ( (isset($params['air_flow_min']) && $params['air_flow_min'] != '') || 
                    (isset($params['air_flow_max']) && $params['air_flow_max'] != '') ) {
                unset($params['air_flow']);
            }
			if ( (isset($params['air_pressure_min']) && $params['air_pressure_min'] != '') || 
                    (isset($params['air_pressure_max']) && $params['air_pressure_max'] != '') ) {
                unset($params['air_pressure']);
            }
            
			$airFlow = null;
			$airPressure = null;
			if (isset($params['air_flow']) && $params['air_flow'] !== '') {
				$airFlow = $params['air_flow'];
				
				// 转换为数据库中的标准单位 m³/h
				if (isset($units['flow']) && isset($conversionFactors['flow'][$units['flow']])) {
					$airFlow = $airFlow * $conversionFactors['flow'][$units['flow']];
				}
			}
			
			if (isset($params['air_pressure']) && $params['air_pressure'] !== '') {
				$airPressure = $params['air_pressure'];
				
				// 转换为数据库中的标准单位 Pa
				if (isset($units['pressure']) && isset($conversionFactors['pressure'][$units['pressure']])) {
					$airPressure = $airPressure * $conversionFactors['pressure'][$units['pressure']];
				}
			}
			
			// 考虑容差范围
			$minAirFlow = $airFlow ? ceil($airFlow * (1 + $tolerance_min/100)) : 0;
			$maxAirFlow = $airFlow ? ceil($airFlow * (1 + $tolerance_max/100)) : 0;
			$minAirPressure = $airPressure ? ceil($airPressure * (1 + $tolerance_min/100)) : 0;
			$maxAirPressure = $airPressure ? ceil($airPressure * (1 + $tolerance_max/100)) : 0;
            
            $maxVspMap = [];
            $lastPQsql = '';
            $chosenVspMap = [];
            /*
            if ( $minAirFlow || $maxAirFlow || $minAirPressure || $maxAirPressure ) {
                
                $usePQ = true;
                            
                // ① 相关子查询：算出每个 fan 的最小 vsp（用于排除）
                $subMin = '(SELECT fan_product_id, MIN(vsp) AS min_vsp 
                           FROM fa_fan_pqdata GROUP BY fan_product_id)';

                // ② 主查询：只看 “vsp > min_vsp” 的记录，再按你的气动窗口过滤
                $q = Db::name('fan_pqdata')->alias('pq')
                    ->join([$subMin => 'm'], 'm.fan_product_id = pq.fan_product_id')
                    ->whereRaw('pq.vsp > m.min_vsp');

                // —— 套用原来对风量/静压的区间过滤（保持你的写法不变）——
                if ($minAirFlow && $maxAirFlow) {
                    $q->where('pq.air_flow_m3h', 'between', [$minAirFlow, $maxAirFlow]);
                } elseif ($minAirFlow) {
                    $q->where('pq.air_flow_m3h', '>=', $minAirFlow);
                } elseif ($maxAirFlow) {
                    $q->where('pq.air_flow_m3h', '<=', $maxAirFlow);
                }

                if ($minAirPressure && $maxAirPressure) {
                    $q->where('pq.air_pressure', 'between', [$minAirPressure, $maxAirPressure]);
                } elseif ($minAirPressure) {
                    $q->where('pq.air_pressure', '>=', $minAirPressure);
                } elseif ($maxAirPressure) {
                    $q->where('pq.air_pressure', '<=', $maxAirPressure);
                }

                // ③ 对每个 fan 取 “满足条件的最小 vsp”
                $rows = $q->field('pq.fan_product_id, MIN(pq.vsp) AS chosen_vsp')
                          ->group('pq.fan_product_id')
                          ->select();

                $lastPQsql = \think\Db::getLastSql(); // 继续丢给前端调试

                foreach ($rows as $r) {
                    $chosenVspMap[$r['fan_product_id']] = (float)$r['chosen_vsp'];
                }
                
            } else {
                $usePQ = false;
            }
            */

if ( $minAirFlow || $maxAirFlow || $minAirPressure || $maxAirPressure ) {
    $usePQ = true;
    
    // 修改：直接使用最大VSP进行查询
    $subQuery = Db::name('fan_pqdata')
        ->field('fan_product_id, MAX(vsp) as max_vsp')
        ->group('fan_product_id');
    
    $q = Db::name('fan_pqdata')->alias('pq')
        ->join([$subQuery->buildSql() => 'm'], 'm.fan_product_id = pq.fan_product_id AND m.max_vsp = pq.vsp');
    
    // 应用风量和静压过滤条件
    if ($minAirFlow && $maxAirFlow) {
        $q->where('pq.air_flow_m3h', 'between', [$minAirFlow, $maxAirFlow]);
    } elseif ($minAirFlow) {
        $q->where('pq.air_flow_m3h', '>=', $minAirFlow);
    } elseif ($maxAirFlow) {
        $q->where('pq.air_flow_m3h', '<=', $maxAirFlow);
    }

    if ($minAirPressure && $maxAirPressure) {
        $q->where('pq.air_pressure', 'between', [$minAirPressure, $maxAirPressure]);
    } elseif ($minAirPressure) {
        $q->where('pq.air_pressure', '>=', $minAirPressure);
    } elseif ($maxAirPressure) {
        $q->where('pq.air_pressure', '<=', $maxAirPressure);
    }

    // 获取满足条件的风机及其最大VSP
    $rows = $q->field('pq.fan_product_id, pq.vsp as chosen_vsp')
              ->group('pq.fan_product_id')
              ->select();

    $lastPQsql = $q->getLastSql();

    $chosenVspMap = [];
    foreach ($rows as $r) {
        $chosenVspMap[$r['fan_product_id']] = (float)$r['chosen_vsp'];
    }
    
} else {
    $usePQ = false;
}

            /*
            // 20250808 更新，不再使用最大vsp曲线，找到哪条曲线数据合适，就用哪条     claud       
            if ( $minAirFlow || $maxAirFlow || $minAirPressure || $maxAirPressure ) {
              $usePQ = true;

              // 获取满足条件的风机及其合适的VSP
              $suitableVspMap = $this->findSuitableVspForFans($minAirFlow, $maxAirFlow, $minAirPressure, $maxAirPressure);
              $maxVspMap = $suitableVspMap; // 重命名保持兼容性
              
              $lastPQsql = 'Optimized VSP selection query';
            } else {
              $usePQ = false;
            }
            */
			$currentLang = Lang::detect();//Cookie::get('user_language_selected') ?? 
            
			// 获取匹配的风机详细信息
			$query = $this->model->alias('p')
				->join('fan_type t', 'p.fan_type_id = t.id')
				->join('fan_type_lang tl', 'tl.fan_type_id = t.id')
				//->join('fan_productlang pl', 'pl.fan_product_id = p.id')
				->field('p.*, tl.name as type_name, t.image as fanimage');
				
            $query->where('tl.lang', $currentLang); 
            
			if ( $usePQ ) {
                $query->whereIn('p.id', array_keys($chosenVspMap));
            }

			// 应用风机类型筛选
			if (!empty($typeIds)) {
				$query->whereIn('p.fan_type_id', $typeIds);
			}
			
			// 在search方法中添加电源类型筛选
			if (isset($params['powertype']) && $params['powertype']) {
				$query->where('p.powertype', $params['powertype']);
			}	
            
            if (isset($params['motor_type']) && $params['motor_type']) {
                $query->where('p.motor_type', $params['motor_type']);
            }
            
            if (isset($params['custom_str3']) && $params['custom_str3']) {
                $query->where('p.custom_str3', $params['custom_str3']);
            }
            
			if (isset($params['fan_model']) && $params['fan_model']) {
				$query->where('p.fan_model', 'like', '%' . trim($params['fan_model']) . '%');
                
                if ( $this->userAuth->isLogin() ) {
                    $user = $this->userAuth->getUser();
                    \app\common\model\OperationLog::record('user', $user->id, 'search', '搜索风机', '风机型号：' . trim($params['fan_model']));
                }
			}	
            
            /***  通用区间字段：xxx_min / xxx_max ***/
            $rangeMap = [
                'rated_voltage'    => 'p.rated_voltage',
                'air_flow'         => 'p.air_flow',
                'air_pressure'     => 'p.air_pressure',
                'rated_power'      => 'p.rated_power',
                'rated_speed'      => 'p.rated_speed',
                'impeller_diameter'=> 'p.impeller_diameter',
                // 如有更多，在此补充
            ];
            
            foreach ($rangeMap as $key => $column) {
                $minKey = $key . '_min';
                $maxKey = $key . '_max';

                $hasMin = isset($params[$minKey]) && $params[$minKey] !== '';
                $hasMax = isset($params[$maxKey]) && $params[$maxKey] !== '';
                
                if ( $key == 'air_flow' ) {
                    $minValue = $hasMin ? floatval($params[$minKey]) * $conversionFactors['flow'][$units['flow']] : 0;
                    $maxValue = $hasMax ? floatval($params[$maxKey]) * $conversionFactors['flow'][$units['flow']] : 0;
                } else if ( $key == 'air_pressure' ) {
                    $minValue = $hasMin ? floatval($params[$minKey]) * $conversionFactors['pressure'][$units['pressure']] : 0;
                    $maxValue = $hasMax ? floatval($params[$maxKey]) * $conversionFactors['pressure'][$units['pressure']] : 0;
                } else if ( $key == 'rated_power' ) {
                    $minValue = $hasMin ? floatval($params[$minKey]) * $conversionFactors['power'][$units['power']] : 0;
                    $maxValue = $hasMax ? floatval($params[$maxKey]) * $conversionFactors['power'][$units['power']] : 0;
                } else {
                    $minValue = $hasMin ? floatval($params[$minKey]) : 0;
                    $maxValue = $hasMax ? floatval($params[$maxKey]) : 0;
                }
                
                if ($hasMin && $hasMax) {
                    $query->where($column, 'between', [$minValue, $maxValue]);
                } elseif ($hasMin) {
                    $query->where($column, '>=', $minValue);
                } elseif ($hasMax) {
                    $query->where($column, '<=', $maxValue);
                }
            }


            // 只显示状态为正常的产品
            $query->where('p.status', '1');
			
			// 排序
			$sort = isset($params['sort']) ? $params['sort'] : 'air_flow';
			$order = isset($params['order']) ? $params['order'] : 'asc';
			$query->order('p.' . $sort, $order);
			
			// 分页
			$page = isset($params['page']) ? intval($params['page']) : 1;
			$limit = isset($params['limit']) ? intval($params['limit']) : 50;
			
			$result = $query->paginate($limit, false, ['page' => $page]);
			$lastSql = $query->getLastSql();
			
			// 获取总数和列表
			$total = $result->total();
			$lists = $result->items();
			
			// 处理图片路径


            // 批量获取所有需要的图片信息
            //$fanModels = array_column($lists, 'fan_model');
            $fanModels = array_unique(array_filter(array_column($lists, 'product_images')));
            //$circuitModels = array_unique(array_filter(array_column($lists, 'circuit_image')));
            //$outlineModels = array_unique(array_filter(array_column($lists, 'outline_image')));

            // 批量查询图片
            $mainImages = $this->getMainImages($fanModels);
            //$circuitImages = $this->getCircuitImages($circuitModels);
            //$outlineImages = $this->getOutlineImages($outlineModels);

            // 处理图片路径
            foreach ($lists as &$item) {
                $fanModel = $item['product_images'];
                $circuitModel = $item['circuit_image'];
                $outlineModel = $item['outline_image'];
                
                // 设置默认图片
                $defaultImage = $item['fanimage'];
                
                // 获取产品主图（基于fan_model）
                $item['product_images'] = $this->getImageUrl($fanModel, $mainImages, $defaultImage);
                $item['image'] = $this->getImageUrl($fanModel, $mainImages, $defaultImage);
                
                // 获取电路图（基于circuit_image字段值）
                //$item['circuit_image'] = $this->getImageUrl($circuitModel, $circuitImages, $defaultImage);
                
                // 获取外形尺寸图（基于outline_image字段值）
                //$item['outline_image'] = $this->getImageUrl($outlineModel, $outlineImages, $defaultImage);
                
                
                $item['chosen_vsp'] = isset($chosenVspMap[$item['id']]) ? $chosenVspMap[$item['id']] : null;

            }
                    
			return json([
				'code' => 1,
				'msg' => '',
				'total' => $total,
				'data' => $lists,
				'lastSql' => $lastSql,
				'lastPQsql' => $lastPQsql,
			]);
		}
		
		return $this->error(__('Invalid request'));
	}


    /**
     * 批量获取主图信息（基于风机型号）
     * @param array $fanModels 风机型号数组
     * @return array 图片信息映射
     */
    protected function getMainImages($fanModels)
    {
        if (empty($fanModels)) {
            return [];
        }
        
        // 构建查询条件：filename包含风机型号
        $whereConditions = [];
        foreach ($fanModels as $fanModel) {
            $models = explode(',', $fanModel);
            foreach ($models as $fm) {
                $whereConditions[] = ['filename', 'like', '%' . $fm . '%'];
            }
            
        }
        
        $attachmentList = Db::name('attachment')
            ->where(function($query) use ($whereConditions) {
                foreach ($whereConditions as $condition) {
                    $query->whereOr($condition[0], $condition[1], $condition[2]);
                }
            })
            ->where('mimetype', 'like', 'image/%')
            ->where('category', 'in', ['main']) // 主图分类
            ->field('id,category,filename,url,mimetype')
            ->select();
        
        // 按风机型号分组
        $groupedImages = [];
        foreach ($attachmentList as $attachment) {
            foreach ($fanModels as $fanModel) {
                $models = explode(',', $fanModel);
                foreach ($models as $fm) {
                    if (strpos($attachment['filename'], $fm) !== false) {
                        // 优先使用main分类，如果没有则使用第一个匹配的
                        if (!isset($groupedImages[$fm]) || $attachment['category'] === 'main') {
                            $groupedImages[$fm] = $attachment['url'];
                        }
                        break;
                    }
                }
            }
        }
        
        return $groupedImages;
    }

    /**
     * 批量获取电路图信息（基于电路板型号）
     * @param array $circuitModels 电路板型号数组
     * @return array 图片信息映射
     */
    protected function getCircuitImages($circuitModels)
    {
        if (empty($circuitModels)) {
            return [];
        }
        
        // 构建查询条件：filename包含电路板型号
        $whereConditions = [];
        foreach ($circuitModels as $circuitModel) {
            $whereConditions[] = ['filename', 'like', '%' . $circuitModel . '%'];
        }
        
        $attachmentList = Db::name('attachment')
            ->where(function($query) use ($whereConditions) {
                foreach ($whereConditions as $condition) {
                    $query->whereOr($condition[0], $condition[1], $condition[2]);
                }
            })
            ->where('mimetype', 'like', 'image/%')
            ->where('category', 'in', ['circuit']) // 电路图分类
            ->field('id,category,filename,url,mimetype')
            ->select();
        
        // 按电路板型号分组
        $groupedImages = [];
        foreach ($attachmentList as $attachment) {
            foreach ($circuitModels as $circuitModel) {
                if (strpos($attachment['filename'], $circuitModel) !== false) {
                    // 优先使用circuit分类
                    if (!isset($groupedImages[$circuitModel]) || $attachment['category'] === 'circuit') {
                        $groupedImages[$circuitModel] = $attachment['url'];
                    }
                    break;
                }
            }
        }
        
        return $groupedImages;
    }

    /**
     * 批量获取外形图信息（基于外形图编号）
     * @param array $outlineModels 外形图编号数组
     * @return array 图片信息映射
     */
    protected function getOutlineImages($outlineModels)
    {
        if (empty($outlineModels)) {
            return [];
        }
        
        // 构建查询条件：filename包含外形图编号
        $whereConditions = [];
        foreach ($outlineModels as $outlineModel) {
            $whereConditions[] = ['filename', 'like', '%' . $outlineModel . '%'];
        }
        
        $attachmentList = Db::name('attachment')
            ->where(function($query) use ($whereConditions) {
                foreach ($whereConditions as $condition) {
                    $query->whereOr($condition[0], $condition[1], $condition[2]);
                }
            })
            ->where('mimetype', 'like', 'image/%')
            ->where('category', 'in', ['outline']) // 外形图分类
            ->field('id,category,filename,url,mimetype')
            ->select();
        
        // 按外形图编号分组
        $groupedImages = [];
        foreach ($attachmentList as $attachment) {
            foreach ($outlineModels as $outlineModel) {
                if (strpos($attachment['filename'], $outlineModel) !== false) {
                    // 优先使用outline分类
                    if (!isset($groupedImages[$outlineModel]) || $attachment['category'] === 'outline') {
                        $groupedImages[$outlineModel] = $attachment['url'];
                    }
                    break;
                }
            }
        }
        
        return $groupedImages;
    }

    /**
     * 获取图片URL
     * @param string $model 型号/编号
     * @param array $imageMap 图片映射数组
     * @param string $defaultImage 默认图片
     * @return string 图片URL
     */
    protected function getImageUrl($model, $imageMap, $defaultImage)
    {
        $key = $model;
        if (strpos($model, ',') !== false ){
            $models = explode(',', $model);
            $key = $models[0];
        } 
        if (empty($key) || !isset($imageMap[$key])) {
            return $defaultImage;
        }
        
        return $this->validateImagePath($imageMap[$key], $defaultImage);
    }


    /**
     * 验证图片路径是否存在
     * @param string $imagePath 图片路径
     * @param string $defaultImage 默认图片
     * @return string 有效的图片路径
     */
    protected function validateImagePath($imagePath, $defaultImage)
    {
        if (empty($imagePath)) {
            return $defaultImage;
        }
        
        // 检查文件是否存在
        $fullPath = ROOT_PATH . 'public' . $imagePath;
        if (file_exists($fullPath)) {
            return $imagePath;
        }
        
        return $defaultImage;
    }

    /**
     * 风机详情
     */
    public function detail()
    {
        //var_dump($this->auth->check('fan/downloadspec'));exit;
        $lang = Lang::detect();
		$id = $this->request->param('id/d');
		if (!$id) {
			$this->error(__('Invalid parameters'));
		}
        
        $fan = $this->model->alias('p')
            ->join('fan_type t', 'p.fan_type_id = t.id')
            ->join('fan_type_lang tl', 'p.fan_type_id = tl.fan_type_id')
            ->field('p.*, tl.name as type_name, t.image as fanimage, tl.description as type_description')
            ->where('p.id', $id)
            ->where('p.status', '1')
            ->where('tl.lang', $lang)
            ->find();
        
        if (!$fan) {
            $this->error(__('Fan not found'));
        }
        
        // 处理图片
        if ($fan['product_images']) {
            $fan['images'] = explode(',', $fan['product_images']);
        } else {
            $fan['images'] = [];
        }
        
        // 获取多语言信息
        
        $fanLang = Db::name('fan_productlang')
            ->where('fan_product_id', $id)
            ->where('lang', $lang)
            ->find();
        //var_dump( $fanLang);exit;
        if ($fanLang) {
            $fan['title'] = $fanLang['title'] ?: $fan['fan_model'];
            $fan['description'] = $fanLang['description'];
            $fan['features'] = $fanLang['features'];
        } else {
            $fan['title'] = $fan['fan_model'];
            $fan['description'] = $fan['type_description'];
            $fan['features'] = '';
        }

        // 批量获取所有需要的图片信息
        //$fanModels = array_column($lists, 'fan_model');
        $fanModels      = [$fan['product_images']];
        $circuitModels = [$fan['circuit_image']];
        $outlineModels = [$fan['outline_image']];

        // 批量查询图片
        $mainImages = $this->getMainImages($fanModels);
        $circuitImages = $this->getCircuitImages($circuitModels);
        $outlineImages = $this->getOutlineImages($outlineModels);

        // 处理图片路径

        $fanModel = $fan['product_images'];
        $circuitModel = $fan['circuit_image'];
        $outlineModel = $fan['outline_image'];
        
        // 设置默认图片
        $defaultImage = $fan['fanimage'];
        
        // 获取产品主图（基于fan_model）
        $fan['product_images'] = $this->getImageUrl($fanModel, $mainImages, $defaultImage);
        $fan['image'] = $this->getImageUrl($fanModel, $mainImages, $defaultImage);
        
        // 获取电路图（基于circuit_image字段值）
        $fan['circuit_image'] = $this->getImageUrl($circuitModel, $circuitImages, $defaultImage);
        
        // 获取外形尺寸图（基于outline_image字段值）
        $fan['outline_image'] = $this->getImageUrl($outlineModel, $outlineImages, $defaultImage);

		// 获取最小和最大风量值
		$minMaxFlow = Db::name('fan_product')
			->field('MIN(air_flow) as min_flow, MAX(air_flow) as max_flow')
			->where('air_flow', '>', 0) // 排除零值
			->find();
		
		// 将范围数据传递给视图
		$this->assign('air_flow_range', [
			'min' => round($minMaxFlow['min_flow']), 
			'max' => round($minMaxFlow['max_flow'])
		]);
        
        // 获取PQ曲线数据
        $pqData = Db::name('fan_pqdata')
            ->where('fan_product_id', $id)
            ->order('air_flow_m3h', 'asc')
            ->select();
            
        $efficiency = $fan['rated_power'] > 0 ? ceil(($fan['air_flow'] * $fan['air_pressure'])  * 100 / ($fan['rated_power'] * 3600)) : 60;
        
        if ( $this->userAuth->isLogin() ) {
            $user = $this->userAuth->getUser();
            \app\common\model\OperationLog::record('user', $user->id, 'view', '查看风机详情', '风机型号：' . trim($fan['fan_model']));
        }
        
        $acclist = config('site.acclist') ?? '';
        if ( !empty($acclist) ) {
            $acc = explode("\r\n", $acclist);
            $this->assign('acclist', $acc);
        } else {
            $this->assign('acclist', []);
        }
        
        $vsprange = explode('-', $fan['speed_control']);
        if ( count($vsprange) == 2 ) {
            $this->assign('vsprange', [
                'min' => $vsprange[0], 
                'max' => $vsprange[1]
            ]);
        } else {
            $this->assign('vsprange', [
                'min' => 1.5, 
                'max' => 10
            ]);
        }
        
        // AC风机不推算
        $is_AC = $fan['motor_type'] == 'AC' ? 'true' : 'false';
        $ac_groups = config('site.ac_groups') ?? '';
        if ( !empty($ac_groups) ) {
            $ac_models = explode("\r\n", $ac_groups);
            if ( in_array($fan['fan_model'], $ac_models) ) {
                $is_AC = 'true';
            }
        }
        
        
        $this->assign('fan', $fan);
        $this->assign('is_AC', $is_AC );
        $this->assign('fanacc', array_map('strtolower', explode(',', str_replace('，',',',$fan['accessories']))));
        $this->assign('pqData', $pqData);
        $this->assign('efficiency', $efficiency);

		$this->assign('title', 'Fan Details');
		$this->assign('description', $fan['description']);
		$this->assign('auth', $this->auth);
		$this->assign('fan_dimm', $fan['impeller_diameter']);
        
        $config = $this->view->config;
        $config['jsname'] = 'frontend/detail'; // 对应 /assets/js/frontend/detail.js
        $this->assign('config', $config);
        
        return $this->view->fetch();
    }

	/**
	 * 获取风机信息
	 */
	public function getFanInfo()
	{
		$id = $this->request->param('id/d');
		if (!$id) {
			$this->error(__('Invalid parameters'));
		}
		
		// 获取风机信息
		$fan = $this->model->find($id);
		if (!$fan) {
			$this->error(__('Fan not found'));
		}
		
		$this->success('', null, $fan);
	}

	/**
	 * 获取PQ数据
	 */
	public function getPQData()
	{
		$id = $this->request->param('id/d');
		if (!$id) {
			$this->error(__('Invalid parameters'));
		}
		
		// 获取风机的PQ数据
		$pqData = model('FanPqdata')->where('fan_product_id', $id)->select();
		if (!$pqData) {
			$this->error(__('No PQ data found'));
		}
		
		$this->success('', null, $pqData);
	}


    /**
     * 风机对比
     */
    public function compare()
    {
        $ids = $this->request->param('ids', '');
        
        if (!$ids) {
            $this->error(__('Please select fans to compare'));
        }
        
        $idArr = explode(',', $ids);
        if (count($idArr) < 2 || count($idArr) > 4) {
            $this->error(__('Please select 2-4 fans to compare'));
        }
        
        $lang = Lang::detect();
         
        $fans = $this->model->alias('p')
            //->join('fan_type t', 'p.fan_type_id = t.id')
            ->join('fan_type_lang t', 'p.fan_type_id = t.fan_type_id')
            ->field('p.*, t.name as type_name')
            ->whereIn('p.id', $idArr)
            ->whereIn('t.lang', $lang)
            ->where('p.status', '1')
            ->select();
        
        if (count($fans) < 2) {
            $this->error(__('Not enough valid fans to compare'));
        }

        $ac_groups = config('site.ac_groups') ?? '';
        $ac_models = explode("\r\n", $ac_groups);
        
        // 获取PQ曲线数据
        $fanCurves = [];
        foreach ($fans as &$fan) {
            $pqData = Db::name('fan_pqdata')
                ->where('fan_product_id', $fan['id'])
                 ->where('vsp', '>', 1.5)
                ->select();
            
            $fanCurves[$fan['id']] = $pqData;
            
        
            // AC风机不推算
            $fan['is_AC'] = $fan['motor_type'] == 'AC' ? 'true' : 'false';
            if ( in_array($fan['fan_model'], $ac_models) ) {
                $fan['is_AC'] = 'true';
            }
            
        }
        
        $this->assign('title', __('Fan Comparison'));
        $this->assign('fans', $fans);
        $this->assign('fanCurves', $fanCurves);

        $config = $this->view->config;
        $config['jsname'] = 'frontend/compare'; // 对应 /assets/js/frontend/compare.js
        $this->assign('config', $config);
        
        return $this->view->fetch();
    }
	
	public function fanwall()
	{
		$this->assign('title', __('Fan Wall'));
		return $this->view->fetch();
	}



/**
 * 风机墙配置页面
 */
public function fwt()
{
    // 获取风机类型
    $fanTypes = Db::name('fan_product')
        ->where('fanwall', 'in', ['AHU', 'CTF'])
        ->where('status', '1')
        ->group('fanwall')
        ->column('fanwall');
    
    $this->assign('fanTypes', $fanTypes);
    $this->assign('title', 'Fan Wall Configuration');
    return $this->view->fetch();
}

/**
 * 计算候选方案（单工况）
 * 入参：fan_type, width, height, airflow, pressure, redundancy 等
 */
public function configure()
{
    $params  = $this->request->post();

    $fanType = strtoupper($params['fan_type'] ?? 'AHU'); // AHU / CTF
    $W       = floatval($params['width']    ?? 0);
    $H       = floatval($params['height']   ?? 0);
    $Qreq    = floatval($params['airflow']  ?? 0);       // 目标风量 m3/h
    $Preq    = floatval($params['pressure'] ?? 0);       // 目标静压 Pa
    $redund  = trim($params['redundancy']   ?? 'N');     // N, N+1, ...

    $candidates = $this->buildFanwallCandidates($fanType, $W, $H, $Qreq, $Preq, $redund);

    return $this->success('ok', null, ['candidates' => $candidates]);
}

/**
 * 计算候选方案（核心）
 * 入参：fan_type, width, height, airflow, pressure, controller_location,
 *      project_code, project_name, device_code, redundancy
 */
public function configure23()
{
    $params   = $this->request->post();

    $fanType  = strtoupper($params['fan_type'] ?? 'AHU'); // AHU / CTF
    $W        = floatval($params['width'] ?? 0);
    $H        = floatval($params['height'] ?? 0);
    $Qreq     = floatval($params['airflow'] ?? 0);        // 目标风量 m3/h
    $Preq     = floatval($params['pressure'] ?? 0);       // 目标静压 Pa
    $redund   = trim($params['redundancy'] ?? 'N');       // N, N+1, ...

    // AHU 风量修正系数（文档约定）
    $flowCoef = ($fanType === 'AHU') ? 0.96 : 1.00;

    // 仅取参与风机墙的产品
    $products = Db::name('fan_product')
        ->where('status', '1')
        ->where('fanwall', $fanType)
        ->select();

    $candidates = [];

    foreach ($products as $p) {
        $pid = intval($p['id']);

        // 取该型号“最大 VSP”一条曲线
        $maxVsp = Db::name('fan_pqdata')
            ->where('fan_product_id', $pid)
            ->max('vsp');
        if ($maxVsp === null) continue;

        $pq = Db::name('fan_pqdata')
            ->where('fan_product_id', $pid)
            ->where('vsp', $maxVsp)
            ->field('air_flow_m3h as flow, air_pressure as pressure, power, current, speed, efficiency')
            ->select();
        if (!$pq) continue;

        // 在给定静压 Preq 下插值单机工作点
        $work = $this->interpolateAtPressure($pq, $Preq);
        if (!$work) {
            // 目标静压高于该曲线最大静压或数据异常
            continue;
        }

        $Qsingle       = floatval($work['flow']);           // 单机在 Preq 下风量
        $P_single_kw   = floatval($work['power'] ?? 0) / 1000.0;
        $I_single      = isset($work['current']) ? floatval($work['current']) : null;
        $rpm_single    = isset($work['speed']) ? intval($work['speed']) : null;
        $eff_single    = isset($work['efficiency']) ? floatval($work['efficiency']) : null;

        // **关键过滤**：单机在 Preq 下风量 <= 0，则该型号无法在并联下提供风量 → 直接跳过
        if ($Qsingle <= 0) {
            continue;
        }

        // AHU/CTF 系数修正
        $Qsingle_eff = $Qsingle * $flowCoef;

        // 精确台数；若 Qsingle_eff 非法，前面已 continue
        $qty_exact = ($Qsingle_eff > 0) ? ($Qreq / $Qsingle_eff) : 0.0;

        // 推算台数（按你的规则：ceil(exact + 0.5)）
        $qty_base = (int)ceil($qty_exact + 0.5);

        // 冗余台数
        $qty_config = $this->applyRedundancy($qty_base, $redund);
        
        // 新增：用于布局的几何参数（mm）
        $impellerDmm = floatval($p['impeller_diameter'] ?? 0);
        $outlineLmm  = floatval($p['outline_length']    ?? 0);
        $outlineWmm  = floatval($p['outline_width']     ?? 0);

        // 如果有开口尺寸，就做一次几何过滤（前后端规则统一）
        if ($W > 0 && $H > 0) {
            if (!$this->canLayoutFanWall($fanType, $W, $H, $qty_config, $outlineWmm, $outlineLmm, $impellerDmm)) {
                // 这个型号在当前开口下不可能摆下指定台数，直接跳过
                continue;
            }
        }

        // 运行台数（不含冗余）
        $qty_run = $qty_base;

        // 生成风机墙 PQ 曲线（单机曲线的 flow × 运行台数 × 系数）
        $pq_wall = $this->buildWallCurveFromSingle($pq, $qty_run, $flowCoef);

        // 单机/风机墙功率–风量曲线
        $power_curve_single = [];
        $power_curve_wall   = [];
        foreach ($pq as $pt) {
            $f   = floatval($pt['flow']);
            $pkw = floatval($pt['power'] ?? 0) / 1000.0;
            $power_curve_single[] = ['flow' => $f,                        'power_kw' => $pkw];
            $power_curve_wall[]   = ['flow' => $f * $qty_run * $flowCoef, 'power_kw' => $pkw * $qty_run];
        }

        // 运行功率/电流（运行台数）
        $run_power_total_kw = $P_single_kw * $qty_run;
        $run_speed_rpm      = $rpm_single;
        $work_eff_pct       = $eff_single;

        // 名义/额定参数（产品表 * 配置台数）
        $rated_power_total_kw   = floatval($p['rated_power'] ?? 0) / 1000.0 * $qty_config;
        $rated_current_total_a  = floatval($p['rated_current'] ?? 0)      * $qty_config;
        $nominal_flow_total     = floatval($p['air_flow'] ?? 0)           * $qty_config;
        $nominal_pressure       = floatval($p['air_pressure'] ?? 0);

        // 冗余量（配置能力 - 目标）/ 目标
        $redundancy_ratio = ($Qsingle_eff * $qty_config - $Qreq) / max($Qreq, 1e-6) * 100.0;

        // 行列数（近似方阵）
        list($rows, $cols) = $this->bestGrid($qty_config);

        $candidates[] = [
            'product_id'   => $pid,
            'fan_model'    => $p['fan_model'],
            'fan_type'     => $fanType, 
            
            'qty_exact'    => round($qty_exact, 2),
            'qty'          => $qty_base,
            'qty_config'   => $qty_config,
            'rows'         => $rows,
            'cols'         => $cols,
            'redundancy'   => $redund,

            'run_power_kw' => round($run_power_total_kw, 3),
            'run_speed'    => $run_speed_rpm,
            'efficiency_pct'=> $work_eff_pct,

            'rated_speed'  => intval($p['rated_speed']),
            'rated_power_total_kw'  => round($rated_power_total_kw, 3),
            'rated_current_total_a' => round($rated_current_total_a, 3),
            'nominal_flow_total'    => round($nominal_flow_total, 3),
            'nominal_pressure'      => $nominal_pressure,

            'single_rated_power_kw' => round(floatval($p['rated_power'] ?? 0)/1000.0, 3),
            'single_rated_current_a'=> isset($p['rated_current']) ? floatval($p['rated_current']) : null,
            'single_work_power_kw'  => round($P_single_kw, 3),
            'single_work_current_a' => $I_single,
            'redundancy_ratio_pct'  => round($redundancy_ratio, 3),

            // === 新增：布局用的几何参数 ===
            'impeller_diameter' => isset($p['impeller_diameter']) ? floatval($p['impeller_diameter']) : null,
            'outline_length'    => isset($p['outline_length'])    ? floatval($p['outline_length'])    : null,
            'outline_width'     => isset($p['outline_width'])     ? floatval($p['outline_width'])     : null,

            // 前端绘图：单机最大 VSP PQ、风机墙 PQ、功率曲线（单/墙）
            'pq_single'    => array_map(function($pt){
                return [
                    'flow'     => floatval($pt['flow']),
                    'pressure' => floatval($pt['pressure'])
                ];
            }, $pq),
            'pq_wall'      => $pq_wall,
            'power_single' => $power_curve_single,
            'power_wall'   => $power_curve_wall,
        ];
    }

    // 多方案排序（这里按运行功率从低到高）
    usort($candidates, function($a, $b){
        return $a['run_power_kw'] <=> $b['run_power_kw'];
    });

    return $this->success('ok', null, ['candidates' => $candidates]);
}



/**
 * 保存用户选中的一个方案（右侧吸附）
 */
public function saveSelection()
{
    $data = $this->request->post('selection/a', []);
    if (empty($data) || empty($data['project_code']) || empty($data['project_name']) || empty($data['device_code'])) {
        return $this->error( __('Please input project name.') );
    }
    $now = date('Y-m-d H:i:s');
    $data['createdtime'] = $now;
    $data['updatedtime'] = $now;

    // 获取新插入 ID
    $id = Db::name('fanwall_selection')->insertGetId($data);
    $only = $this->request->post('only/d', 0);

    if ($only) {
        $item = Db::name('fanwall_selection')->where('id', $id)->find();
        return $this->success('saved', null, ['item' => $item]);
    } else {
        $list = Db::name('fanwall_selection')->order('id desc')->limit(20)->select();
        return $this->success('saved', null, ['saved' => $list]);
    }
}

/**
 * 预留：导出 ROI 报表（占位接口）
 */
public function exportROI()
{
    // 将来你可以根据 id 或 selection 来生成 Excel / PDF
    $id        = $this->request->post('id/d', 0);
    $selection = $this->request->post('selection/a', []);

    // TODO: 根据 $id / $selection 计算 ROI 并生成文件
    return $this->success('ok', null, ['message' => 'ROI export stub', 'id' => $id]);
}

/**
 * 预留：导出方案书（占位接口）
 */
public function exportProposal()
{
    $id        = $this->request->post('id/d', 0);
    $selection = $this->request->post('selection/a', []);

    // TODO: 根据 $id / $selection 生成方案书（可能包含 PQ 曲线、布局图片等）
    return $this->success('ok', null, ['message' => 'Proposal export stub', 'id' => $id]);
}


/**
 * 预留：导出本次选型结果到 Excel（等待模板）
 */
public function exportExcel()
{
    // TODO: 使用模板渲染 $ids 或 $project_code 对应记录
    // 占位：将来把导出文件返回下载 URL
    return $this->success('export stub');
}

/**
 * 预留：查看风机墙示意图（根据尺寸与间隙排布）
 */
public function previewLayout()
{
    // TODO: 根据产品外形/风轮直径与“间隔>=1.8×风轮直径且大于外形尺寸(AHU)”做排布校验
    return $this->success('layout stub');
}

/* ===================== 内部算法 ===================== */
/**
 * 批量筛选多个工况
 *
 * 请求格式示例：
 * POST /fan/batchFilter
 *
 * 全局参数（可选）：
 *  - fan_type
 *  - width
 *  - height
 *  - redundancy
 *  - limit  每个工况返回的候选方案数量，默认 3
 *
 * items：数组，每项为一个工况，可覆盖全局参数：
 *  items: [
 *      { "airflow": 12000, "pressure": 750 },
 *      { "airflow": 15000, "pressure": 800, "redundancy": "N+1" }
 *  ]
 */
public function batchFilter()
{
    if (!$this->request->isPost()) {
        return $this->error('Invalid request method');
    }

    // 全局参数（所有工况通用，单条里可以覆盖）
    $global = $this->request->post();
    // 避免 items 本身被 merge 进去
    $items = isset($global['items']) ? $global['items'] : $this->request->post('items', []);
    unset($global['items']);

    // 兼容前端把 items 当成 json 字符串传
    if (!is_array($items)) {
        $raw = trim((string)$items);
        if ($raw !== '') {
            $decoded = json_decode($raw, true);
            if (json_last_error() === JSON_ERROR_NONE && is_array($decoded)) {
                $items = $decoded;
            }
        }
    }

    if (empty($items) || !is_array($items)) {
        return $this->error('批量筛选参数 items 为空或格式不正确');
    }

    $limit = (int)$this->request->post('limit/d', 3);
    if ($limit <= 0) {
        $limit = 3;
    }

    $result = [];
    $errors = [];

    foreach ($items as $idx => $row) {
        if (!is_array($row)) {
            $errors[] = '第 ' . ($idx + 1) . ' 条数据不是对象/数组，已跳过';
            continue;
        }

        // 单条工况覆盖全局参数
        $params = array_merge($global, $row);

        $fanType = strtoupper($params['fan_type'] ?? 'AHU');
        $W       = floatval($params['width']    ?? 0);
        $H       = floatval($params['height']   ?? 0);
        $Qreq    = floatval($params['airflow']  ?? 0);
        $Preq    = floatval($params['pressure'] ?? 0);
        $redund  = trim($params['redundancy']   ?? 'N');

        if ($Qreq <= 0 || $Preq <= 0) {
            $errors[] = '第 ' . ($idx + 1) . ' 条风量或静压无效，已跳过';
            continue;
        }

        $candidates = $this->buildFanwallCandidates($fanType, $W, $H, $Qreq, $Preq, $redund);

        $result[] = [
            'index'      => $idx,
            'params'     => [
                'fan_type'   => $fanType,
                'width'      => $W,
                'height'     => $H,
                'airflow'    => $Qreq,
                'pressure'   => $Preq,
                'redundancy' => $redund,
            ],
            // 每条工况只返回前 $limit 个方案（按运行功率升序）
            'candidates' => $limit > 0 ? array_slice($candidates, 0, $limit) : $candidates,
        ];
    }

    return $this->success('ok', null, [
        'items'  => $result,
        'errors' => $errors,
    ]);
}

/**
 * 内部核心：根据单个工况参数计算候选方案列表
 *
 * @param string $fanType  AHU / CTF
 * @param float  $W        开口宽度 mm
 * @param float  $H        开口高度 mm
 * @param float  $Qreq     目标风量 m3/h
 * @param float  $Preq     目标静压 Pa
 * @param string $redund   冗余策略：N / N+1 / ...
 * @return array           候选方案数组（已按运行功率从低到高排序）
 */
protected function buildFanwallCandidates($fanType, $W, $H, $Qreq, $Preq, $redund)
{
    $fanType = strtoupper($fanType ?: 'AHU');

    // AHU 风量修正系数（文档约定）
    $flowCoef = ($fanType === 'AHU') ? 0.96 : 1.00;

    // 仅取参与风机墙的产品
    $products = Db::name('fan_product')
        ->where('status', '1')
        ->where('fanwall', $fanType)
        ->select();

    $candidates = [];

    foreach ($products as $p) {
        $pid = intval($p['id']);

        // 取该型号“最大 VSP”一条曲线
        $maxVsp = Db::name('fan_pqdata')
            ->where('fan_product_id', $pid)
            ->max('vsp');
        if ($maxVsp === null) continue;

        $pq = Db::name('fan_pqdata')
            ->where('fan_product_id', $pid)
            ->where('vsp', $maxVsp)
            ->field('air_flow_m3h as flow, air_pressure as pressure, power, current, speed, efficiency')
            ->select();
        if (!$pq) continue;

        // 在给定静压 Preq 下插值单机工作点
        $work = $this->interpolateAtPressure($pq, $Preq);
        if (!$work) {
            // 目标静压高于该曲线最大静压或数据异常
            continue;
        }

        $Qsingle     = floatval($work['flow']);           // 单机在 Preq 下风量
        $P_single_kw = floatval($work['power'] ?? 0) / 1000.0;
        $I_single    = isset($work['current'])    ? floatval($work['current'])    : null;
        $rpm_single  = isset($work['speed'])      ? intval($work['speed'])        : null;
        $eff_single  = isset($work['efficiency']) ? floatval($work['efficiency']) : null;

        // **关键过滤**：单机在 Preq 下风量 <= 0，则该型号无法在并联下提供风量 → 直接跳过
        if ($Qsingle <= 0) {
            continue;
        }

        // AHU/CTF 系数修正
        $Qsingle_eff = $Qsingle * $flowCoef;

        // 精确台数
        $qty_exact = ($Qsingle_eff > 0) ? ($Qreq / $Qsingle_eff) : 0.0;

        // 推算台数（按你的规则：ceil(exact + 0.5)）
        $qty_base = (int)ceil($qty_exact + 0.5);

        // 冗余台数
        $qty_config = $this->applyRedundancy($qty_base, $redund);

        // 新增：用于布局的几何参数（mm）
        $impellerDmm = floatval($p['impeller_diameter'] ?? 0);
        $outlineLmm  = floatval($p['outline_length']    ?? 0);
        $outlineWmm  = floatval($p['outline_width']     ?? 0);

        // 如果有开口尺寸，就做一次几何过滤
        if ($W > 0 && $H > 0) {
            if (!$this->canLayoutFanWall($fanType, $W, $H, $qty_config, $outlineWmm, $outlineLmm, $impellerDmm)) {
                // 这个型号在当前开口下不可能摆下指定台数，直接跳过
                continue;
            }
        }

        // 运行台数（不含冗余）
        $qty_run = $qty_base;

        // 生成风机墙 PQ 曲线（单机曲线的 flow × 运行台数 × 系数）
        $pq_wall = $this->buildWallCurveFromSingle($pq, $qty_run, $flowCoef);

        // 单机/风机墙功率–风量曲线
        $power_curve_single = [];
        $power_curve_wall   = [];
        foreach ($pq as $pt) {
            $f   = floatval($pt['flow']);
            $pkw = floatval($pt['power'] ?? 0) / 1000.0;
            $power_curve_single[] = ['flow' => $f,                        'power_kw' => $pkw];
            $power_curve_wall[]   = ['flow' => $f * $qty_run * $flowCoef, 'power_kw' => $pkw * $qty_run];
        }

        // 运行功率/电流（运行台数）
        $run_power_total_kw = $P_single_kw * $qty_run;
        $run_speed_rpm      = $rpm_single;
        $work_eff_pct       = $eff_single;

        // 名义/额定参数（产品表 * 配置台数）
        $rated_power_total_kw   = floatval($p['rated_power'] ?? 0) / 1000.0 * $qty_config;
        $rated_current_total_a  = floatval($p['rated_current'] ?? 0)      * $qty_config;
        $nominal_flow_total     = floatval($p['air_flow'] ?? 0)           * $qty_config;
        $nominal_pressure       = floatval($p['air_pressure'] ?? 0);

        // 冗余量（配置能力 - 目标）/ 目标
        $redundancy_ratio = ($Qsingle_eff * $qty_config - $Qreq) / max($Qreq, 1e-6) * 100.0;

        // 行列数（近似方阵）
        list($rows, $cols) = $this->bestGrid($qty_config);

        $candidates[] = [
            'product_id'   => $pid,
            'fan_model'    => $p['fan_model'],
            'fan_type'     => $fanType, 

            'qty_exact'    => round($qty_exact, 2),
            'qty'          => $qty_base,
            'qty_config'   => $qty_config,
            'rows'         => $rows,
            'cols'         => $cols,
            'redundancy'   => $redund,

            'run_power_kw' => round($run_power_total_kw, 3),
            'run_speed'    => $run_speed_rpm,
            'efficiency_pct'=> $work_eff_pct,

            'rated_speed'  => intval($p['rated_speed']),
            'rated_power_total_kw'  => round($rated_power_total_kw, 3),
            'rated_current_total_a' => round($rated_current_total_a, 3),
            'nominal_flow_total'    => round($nominal_flow_total, 3),
            'nominal_pressure'      => $nominal_pressure,

            'single_rated_power_kw' => round(floatval($p['rated_power'] ?? 0)/1000.0, 3),
            'single_rated_current_a'=> isset($p['rated_current']) ? floatval($p['rated_current']) : null,
            'single_work_power_kw'  => round($P_single_kw, 3),
            'single_work_current_a' => $I_single,
            'redundancy_ratio_pct'  => round($redundancy_ratio, 3),

            // 布局用的几何参数
            'impeller_diameter' => isset($p['impeller_diameter']) ? floatval($p['impeller_diameter']) : null,
            'outline_length'    => isset($p['outline_length'])    ? floatval($p['outline_length'])    : null,
            'outline_width'     => isset($p['outline_width'])     ? floatval($p['outline_width'])     : null,

            // 前端绘图：单机最大 VSP PQ、风机墙 PQ、功率曲线（单/墙）
            'pq_single'    => array_map(function($pt){
                return [
                    'flow'     => floatval($pt['flow']),
                    'pressure' => floatval($pt['pressure'])
                ];
            }, $pq),
            'pq_wall'      => $pq_wall,
            'power_single' => $power_curve_single,
            'power_wall'   => $power_curve_wall,
        ];
    }

    // 多方案排序（这里按运行功率从低到高）
    usort($candidates, function($a, $b){
        return $a['run_power_kw'] <=> $b['run_power_kw'];
    });

    return $candidates;
}

/**
 * 线性插值：在给定静压 Preq 处求单机工作点（自动按 pressure 升序）
 * - 输入点允许 flow/pressure/power/current 为字符串；内部统一转为 float/int
 * - 若 Preq 高于曲线最大静压，返回 null（表示无法达到）
 */
private function interpolateAtPressure(array $points, float $Preq)
{
    if (empty($points)) return null;

    // 统一转型
    $arr = [];
    foreach ($points as $pt) {
        $arr[] = [
            'flow'       => floatval($pt['flow']),
            'pressure'   => floatval($pt['pressure']),
            'power'      => isset($pt['power']) ? floatval($pt['power']) : null,
            'current'    => isset($pt['current']) ? floatval($pt['current']) : null,
            'speed'      => isset($pt['speed']) ? floatval($pt['speed']) : null,
            'efficiency' => isset($pt['efficiency']) ? floatval($pt['efficiency']) : null,
        ];
    }

    // 按静压升序
    usort($arr, function($a, $b){
        if ($a['pressure'] == $b['pressure']) return 0;
        return ($a['pressure'] < $b['pressure']) ? -1 : 1;
    });

    $n    = count($arr);
    $pMin = $arr[0]['pressure'];
    $pMax = $arr[$n-1]['pressure'];

    if ($Preq > $pMax + 1e-6) {
        // 目标静压超过曲线最大静压：无法达到
        return null;
    }
    if ($Preq <= $pMin + 1e-6) {
        // 小于最小静压（通常≈0Pa），返回起点
        return $arr[0];
    }

    // 恰好命中某个点
    foreach ($arr as $pt) {
        if (abs($pt['pressure'] - $Preq) < 1e-6) {
            return $pt; // 注意：外层会判定 flow<=0 的情况并剔除
        }
    }

    // 夹逼区间插值
    for ($i = 0; $i < $n - 1; $i++) {
        $p1 = $arr[$i];     $p2 = $arr[$i+1];
        if ($Preq >= $p1['pressure'] - 1e-9 && $Preq <= $p2['pressure'] + 1e-9) {
            $den = max($p2['pressure'] - $p1['pressure'], 1e-9);
            $t   = ($Preq - $p1['pressure']) / $den;
            $mix = function($a,$b,$t){ return $a + ($b - $a) * $t; };
            return [
                'flow'       => $mix($p1['flow'],  $p2['flow'],  $t),
                'pressure'   => $Preq,
                'power'      => ($p1['power']      !== null && $p2['power']      !== null) ? $mix($p1['power'],      $p2['power'],      $t) : null,
                'current'    => ($p1['current']    !== null && $p2['current']    !== null) ? $mix($p1['current'],    $p2['current'],    $t) : null,
                'speed'      => ($p1['speed']      !== null && $p2['speed']      !== null) ? intval($mix($p1['speed'],      $p2['speed'],      $t)) : null,
                'efficiency' => ($p1['efficiency'] !== null && $p2['efficiency'] !== null) ? $mix($p1['efficiency'], $p2['efficiency'], $t) : null,
            ];
        }
    }

    // 理论到不了这里：兜底返回最大点
    return $arr[$n-1];
}

/**
 * 风机墙“最大 PQ 曲线”：单机曲线的 flow × 运行台数 × 系数；静压不变
 */
private function buildWallCurveFromSingle(array $singlePoints, int $qty_run, float $flowCoef): array
{
    $out = [];
    foreach ($singlePoints as $pt) {
        $out[] = [
            'flow'     => floatval($pt['flow']) * $qty_run * $flowCoef,
            'pressure' => floatval($pt['pressure']),
        ];
    }
    return $out;
}


/**
 * 冗余策略：N => 2N；N+X => N+X；其它返回 base
 */
private function applyRedundancy(int $qty_base, string $redund): int
{
    $redund = strtoupper(trim($redund));
    $qty_base = max(0, $qty_base);

    // N => 2N
    if ($redund === 'N') {
        return $qty_base * 2;
    }

    // N+X
    if (strpos($redund, 'N+') === 0) {
        $x = intval(substr($redund, 2));
        return max(0, $qty_base + max($x, 0));
    }

    // N-X
    if (strpos($redund, 'N-') === 0) {
        $x = intval(substr($redund, 2));
        $x = max($x, 0);
        $val = $qty_base - $x;

        // 业务上通常至少要保留 1 台，只要原来有台数
        if ($qty_base > 0 && $val < 1) {
            $val = 1;
        }

        return max(0, $val);
    }

    // 默认：按 N 台
    return $qty_base;
}


/**
 * 判断某个方案在给定开口尺寸下，是否可以按 AHU / CTF 规则摆得下
 *
 * AHU  ：每台风机看成 1.8×D 的正方形格子，行列排布；
 * CTF ：按外形尺寸平铺，不考虑额外间隙。
 *
 * @param string $fanType   AHU / CTF
 * @param float  $openingW  开口宽度 mm
 * @param float  $openingH  开口高度 mm
 * @param int    $qty       配置台数（qty_config）
 * @param float  $outlineW  单机外形宽度 mm
 * @param float  $outlineL  单机外形长度 mm
 * @param float  $Dmm       风轮直径 mm
 * @return bool
 */
protected function canLayoutFanWall($fanType, $openingW, $openingH, $qty,
                                    $outlineW, $outlineL, $Dmm)
{
    $openingW = (float)$openingW;
    $openingH = (float)$openingH;
    $qty      = (int)$qty;
    $outlineW = (float)$outlineW;
    $outlineL = (float)$outlineL;
    $Dmm      = (float)$Dmm;

    // 开口尺寸或台数无效：不做几何过滤，直接放行
    if ($openingW <= 0 || $openingH <= 0 || $qty <= 0) {
        return true;
    }

    $fanType = strtoupper($fanType ?: 'AHU');

    // 计算“格子尺寸”
    if ($fanType === 'AHU') {
        // AHU：每台风机的最小尺寸是 1.8×D 的圆，对排布来说就是 1.8D×1.8D 的格子
        if ($Dmm <= 0) {
            // 没有 D 无法判断，退化成只按外形过滤
            if ($outlineW <= 0 || $outlineL <= 0) {
                return true;
            }
            $cellW = $outlineW;
            $cellH = $outlineL;
        } else {
            $cellW = 1.8 * $Dmm;
            $cellH = 1.8 * $Dmm;
        }
    } else {
        // CTF：外形尺寸平铺
        if ($outlineW <= 0 || $outlineL <= 0) {
            return true;
        }
        $cellW = $outlineW;
        $cellH = $outlineL;
    }

    // 行数从 1..qty 尝试，找是否存在能放下的 rows×cols 组合
    for ($rows = 1; $rows <= $qty; $rows++) {
        $cols = (int)ceil($qty / $rows);

        $layoutW = $cols * $cellW;
        $layoutH = $rows * $cellH;

        if ($layoutW <= $openingW + 1e-6 && $layoutH <= $openingH + 1e-6) {
            return true;
        }

        // 如需允许旋转 90°，可以取消下面这段注释：
        /*
        if ($layoutH <= $openingW + 1e-6 && $layoutW <= $openingH + 1e-6) {
            return true;
        }
        */
    }

    return false;
}


/**
 * 近似方阵（行×列）
 */
private function bestGrid(int $qty): array
{
    $qty  = max(1, $qty);
    $rows = (int)floor(sqrt($qty));
    $cols = (int)ceil($qty / max($rows, 1));
    return [$rows, $cols];
}

public function exportFanWallExcel()
{
    // 1) 取 rows，兼容 GET/POST，关闭默认过滤
    $raw = $this->request->param('rows', '', null);
    if (is_array($raw)) {
        $rows = $raw;
    } else {
        $payload = (string)$raw;
        if (strpos($payload, '%5B') !== false || strpos($payload, '%7B') !== false) {
            $payload = urldecode($payload);
        }
        $payload = htmlspecialchars_decode($payload, ENT_QUOTES);
        $rows = json_decode($payload, true);
    }
    if (!$rows || !is_array($rows)) {
        return $this->error('Invalid rows');
    }

    // 2) 载入模板
    $tpl = ROOT_PATH . 'public' . DS . 'template' . DS . 'fanwall_pq_export_template.xlsx';
    if (!is_file($tpl)) {
        return $this->error('Template not found: ' . $tpl);
    }
    $spreadsheet = \PhpOffice\PhpSpreadsheet\IOFactory::load($tpl);
    $sheet = $spreadsheet->getActiveSheet();

    // 3) 从 M6 开始写（起始单元格可改）
    $startCell = 'M6';
    if (!preg_match('/^([A-Z]+)(\d+)$/i', $startCell, $m)) {
        return $this->error('Bad start cell');
    }
    $startColLetter = strtoupper($m[1]);
    $startRow       = intval($m[2]);
    $startColIndex  = \PhpOffice\PhpSpreadsheet\Cell\Coordinate::columnIndexFromString($startColLetter); // 1-based

    // 需要写入的字段顺序（从“Model”列开始）
    $fields = [
        ['key' => 'fan_model',             'type' => 'string'], // A: Model
        ['key' => 'qty_exact',             'type' => 'num2'  ], // B: Exact Units
        //['key' => 'qty',                   'type' => 'int'   ], // C: Estimated Units
        ['key' => 'qty_config',            'type' => 'int'   ], // D: Configured Units
        ['key' => 'run_power_kw',          'type' => 'num2'  ], // E: Running Power (kW)
        ['key' => 'run_speed',             'type' => 'int'   ], // F: Running Speed (rpm)
        ['key' => 'efficiency_pct',        'type' => 'dec2'  ], // G: Duty Point Efficiency (%)
        ['key' => 'rated_power_total_kw',  'type' => 'num2'  ], // H: Rated Power (kW)
        ['key' => 'rated_current_total_a', 'type' => 'num2'  ], // I: Rated Current (A)
        ['key' => 'nominal_flow_total',    'type' => 'int'   ], // J: Nominal Airflow (m³/h)
        ['key' => 'nominal_pressure',      'type' => 'int'   ], // K: Nominal Static Pressure (Pa)
    ];

    // 4) 写入数据
    $rowIdx = $startRow;
    foreach ($rows as $it) {
        foreach ($fields as $i => $f) {
            $colIndex = $startColIndex + $i;
            $addr     = \PhpOffice\PhpSpreadsheet\Cell\Coordinate::stringFromColumnIndex($colIndex) . $rowIdx;
            $val      = isset($it[$f['key']]) ? $it[$f['key']] : '';

            switch ($f['type']) {
                case 'string':
                    $sheet->setCellValueExplicit($addr, (string)$val, DataType::TYPE_STRING);
                    break;
                case 'int':
                    $sheet->setCellValue($addr, (int)($val === '' ? 0 : $val));
                    break;
                case 'num2':
                    $sheet->setCellValue($addr, (float)($val === '' ? 0 : $val));
                    break;
                case 'dec2':
                default:
                    $sheet->setCellValue($addr, (float)($val === '' ? 0 : $val));
                    break;
            }
        }
        $rowIdx++;
    }
    $endRow = $rowIdx - 1;

    // 5) 设置数字格式（从 M 列起，按字段相对位置计算列字母）
    $col = function($offset) use ($startColIndex) {
        return \PhpOffice\PhpSpreadsheet\Cell\Coordinate::stringFromColumnIndex($startColIndex + $offset);
    };

    // #,##0.00（带千分位两位小数）
    foreach ([1,4,7,8] as $ofs) { // qty_exact, run_power_kw, rated_power_total_kw, rated_current_total_a
        $L = $col($ofs);
        $sheet->getStyle("{$L}{$startRow}:{$L}{$endRow}")
              ->getNumberFormat()->setFormatCode(NumberFormat::FORMAT_NUMBER_COMMA_SEPARATED1);
    }
    // 整数列
    foreach ([2,3,5,9,10] as $ofs) { // qty, qty_config, run_speed, nominal_flow_total, nominal_pressure
        $L = $col($ofs);
        $sheet->getStyle("{$L}{$startRow}:{$L}{$endRow}")
              ->getNumberFormat()->setFormatCode('#,##0');
    }
    // 效率两位小数（不加千分位）
    $L = $col(6);
    $sheet->getStyle("{$L}{$startRow}:{$L}{$endRow}")
          ->getNumberFormat()->setFormatCode('0.00');

    // 可选：自动列宽（M ~ ？）
    for ($i = 0; $i < count($fields); $i++) {
        $letter = $col($i);
        $sheet->getColumnDimension($letter)->setAutoSize(true);
    }

    // 6) 保存输出
    $dir = ROOT_PATH . 'public' . DS . 'uploads' . DS . 'export' . DS;
    if (!is_dir($dir)) @mkdir($dir, 0777, true);
    $filename = 'fanwall_data_' . date('Ymd_His') . '.xlsx';
    \PhpOffice\PhpSpreadsheet\IOFactory::createWriter($spreadsheet, 'Xlsx')->save($dir . $filename);

    return $this->success('ok', null, ['url' => request()->domain().'/uploads/export/'.$filename]);
}



}

