package io.github.kyungminseo1.fask;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(FaskHubPlugin.class);
        registerPlugin(OverlayPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
